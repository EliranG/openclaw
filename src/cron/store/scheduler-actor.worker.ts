import { BroadcastChannel } from "node:worker_threads";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { tryResolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { isHeartbeatTaskCronJob } from "../heartbeat-task.js";
import {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  isTimeScheduledJob,
  needsCronTimerMaintenance,
  recomputeJobNextRunAtMs,
  resolveJobErrorBackoffUntilMs,
  resolveNextRunAtMsOrDisable,
} from "../service/jobs-scheduling.js";
import type { CronJobPolicyContext } from "../service/state.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  MAX_CRON_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
} from "../service/timer-execution-timeout.js";
import { hasMissedCronSlotSinceLastRun, isRunnableJob } from "../service/timer-runnable.js";
import type { CronJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";
import { requestCronRunsInWorker } from "./run-queue.worker.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "./run-receipt-store.js";
import { createCronScheduledRunId } from "./run-request-id.js";
import { scheduleUnownedCronJobsInWorker } from "./runtime-maintenance.worker.js";
import { createCronMutationLogger } from "./runtime-mutation.worker.js";
import { mutateCronRuntimeRowsInDatabase } from "./runtime-rows.kernel.js";
import type {
  CronSchedulerOperations,
  CronSchedulerResult,
  CronSchedulerSnapshot,
  CronSchedulerWake,
} from "./scheduler-actor.types.js";
import {
  getCronSchedulerSnapshot,
  installCronSchedulerSnapshot,
  removeCronSchedulerSnapshot,
} from "./scheduler-config.worker.js";
import { recordSkippedCronRunsInWorker } from "./scheduler-state.worker.js";

type SchedulerActor = {
  storeKey: string;
  databasePath: string;
  channels: Map<string, { channel: BroadcastChannel; paused: boolean }>;
  timer?: ReturnType<typeof setTimeout>;
  lastWallMs?: number;
  lastMonotonicMs?: number;
};

const actors = new Map<string, SchedulerActor>();

function emptyResult(): CronSchedulerResult {
  return { jobs: [], ownerless: [], accepted: [], rejected: [], notifications: [], logs: [] };
}

function readJobs(database: OpenClawStateDatabase, storeKey: string): CronJob[] {
  return loadedCronStoreFromRows(
    loadCronRows(database.db, storeKey, undefined, { includeGrantDefinitionProjection: true }),
  ).store.jobs;
}

function collectChanges(
  result: CronSchedulerResult,
  change: Pick<CronSchedulerResult, "jobs" | "notifications" | "logs">,
) {
  result.jobs.push(...change.jobs);
  result.notifications.push(...change.notifications);
  result.logs.push(...change.logs);
}

function scheduleWake(storeKey: string, actor: SchedulerActor, delayMs: number): void {
  actor.timer = setTimeout(() => {
    actor.timer = undefined;
    const wake: CronSchedulerWake = { type: "cron.schedulerWake", storeKey };
    for (const { channel } of actor.channels.values()) {
      const notify = channel.postMessage.bind(channel);
      notify(wake);
    }
    // Admission can be temporarily closed. Retry the notification without retaining
    // a database handle or performing work under the previous command's admission.
    scheduleWake(storeKey, actor, MAX_CRON_TIMER_DELAY_MS);
  }, delayMs);
  actor.timer.unref();
}

function armActor(
  storeKey: string,
  actor: SchedulerActor,
  snapshot: CronSchedulerSnapshot,
  jobs: CronJob[],
  nowMs: number,
): number | undefined {
  clearTimeout(actor.timer);
  actor.timer = undefined;
  if (!snapshot.config.cronEnabled || ![...actor.channels.values()].some(({ paused }) => !paused)) {
    scheduleWake(storeKey, actor, MAX_CRON_TIMER_DELAY_MS);
    return undefined;
  }
  let nextWakeAtMs: number | undefined;
  let enabled = false;
  for (const job of jobs) {
    if (
      !isJobEnabled(job) ||
      !isTimeScheduledJob(job) ||
      !hasCanonicalCronDeliveryMode(job.delivery)
    ) {
      continue;
    }
    enabled = true;
    if (!hasActiveCronRun(job, false) && hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
      nextWakeAtMs = Math.min(nextWakeAtMs ?? Infinity, job.state.nextRunAtMs);
    }
  }
  if (!enabled) {
    scheduleWake(storeKey, actor, MAX_CRON_TIMER_DELAY_MS);
    return undefined;
  }
  const delay =
    nextWakeAtMs === undefined ? MAX_CRON_TIMER_DELAY_MS : Math.max(0, nextWakeAtMs - nowMs);
  const boundedDelay = Math.min(delay === 0 ? MIN_REFIRE_GAP_MS : delay, MAX_CRON_TIMER_DELAY_MS);
  scheduleWake(storeKey, actor, boundedDelay);
  return nextWakeAtMs ?? nowMs + boundedDelay;
}

function isAgentWork(job: CronJob): boolean {
  return (
    job.payload.kind === "agentTurn" ||
    job.payload.kind === "heartbeat" ||
    isHeartbeatTaskCronJob(job) ||
    (job.sessionTarget === "main" && job.payload.kind === "systemEvent" && job.wakeMode === "now")
  );
}

function boundedCatchup(
  database: OpenClawStateDatabase,
  storeKey: string,
  snapshot: CronSchedulerSnapshot,
  nowMs: number,
  result: CronSchedulerResult,
  options?: { skipJobIds?: string[]; deferAgentWork?: boolean },
): CronJob[] {
  const { config } = snapshot;
  const maxImmediate = Math.max(
    0,
    config.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  const staggerMs = Math.max(0, config.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
  const agentDelayMs = Math.max(
    0,
    config.startupDeferredMissedAgentJobDelayMs ??
      DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  );
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const active = listActiveCronRunReceiptJobIdsInDatabase(db, storeKey);
      const skipped = new Set(options?.skipJobIds);
      return mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey,
        jobIds: new Set(loadCronRows(db, storeKey).map((row) => row.job_id)),
        mutate({ jobs }) {
          const changed: CronJob[] = [];
          const notifications: CronSchedulerResult["notifications"] = [];
          const state: CronJobPolicyContext = {
            deps: { nowMs: () => nowMs, log: createCronMutationLogger(result.logs) },
          };
          const missed: CronJob[] = [];
          for (const job of jobs.values()) {
            if (
              !isJobEnabled(job) ||
              skipped.has(job.id) ||
              active.has(job.id) ||
              hasActiveCronRun(job, false)
            ) {
              continue;
            }
            const backoff =
              job.schedule.kind === "cron"
                ? resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS)
                : undefined;
            if (
              backoff !== undefined &&
              nowMs < backoff &&
              hasMissedCronSlotSinceLastRun(job, nowMs) &&
              job.state.nextRunAtMs !== backoff
            ) {
              job.state.nextRunAtMs = backoff;
              changed.push(job);
              continue;
            }
            if (
              !isRunnableJob({
                job,
                nowMs,
                skipAtIfAlreadyRan: true,
                allowCronMissedRunByLastRun: true,
                activeInProcess: false,
              })
            ) {
              continue;
            }
            if (
              config.cronConfig?.skipMissedJobs &&
              (job.schedule.kind === "cron" || job.schedule.kind === "every")
            ) {
              if (
                recomputeJobNextRunAtMs({ state, job, nowMs, deferredNotifications: notifications })
              ) {
                changed.push(job);
              }
            } else {
              missed.push(job);
            }
          }
          missed.sort(
            (left, right) => (left.state.nextRunAtMs ?? 0) - (right.state.nextRunAtMs ?? 0),
          );
          const eligible = options?.deferAgentWork
            ? missed.filter((job) => !isAgentWork(job))
            : missed;
          const immediate = eligible.slice(0, maxImmediate);
          const deferred = [
            ...eligible.slice(maxImmediate).map((job) => ({ job, delayMs: undefined })),
            ...(options?.deferAgentWork
              ? missed.filter(isAgentWork).map((job) => ({ job, delayMs: agentDelayMs }))
              : []),
          ];
          for (const [index, { job, delayMs }] of deferred.entries()) {
            const candidate = nowMs + (delayMs ?? staggerMs) + index * staggerMs;
            job.state.nextRunAtMs = resolveNextRunAtMsOrDisable({
              state,
              job,
              candidate,
              deferredNotifications: notifications,
            });
            job.state.startupCatchupAtMs = job.state.nextRunAtMs;
            changed.push(job);
          }
          if (deferred.length > 0) {
            result.logs.push({
              level: "info",
              fields: {
                immediateCount: immediate.length,
                deferredCount: deferred.length,
                totalMissed: missed.length,
              },
              message: "cron: staggering missed jobs to prevent gateway overload",
            });
          }
          for (const notification of notifications) {
            notification.routing = { defaultAgentId: config.defaultAgentId };
          }
          result.jobs.push(...changed);
          result.notifications.push(...notifications);
          return { upsertJobIds: changed.map((job) => job.id), value: immediate };
        },
      }).value;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: "cron.scheduler-catchup" },
  );
}

export function runCronSchedulerInWorker(
  database: OpenClawStateDatabase,
  command: {
    [Type in "cron.schedulerStart" | "cron.schedulerTick" | "cron.schedulerRefresh"]: {
      type: Type;
      input: CronSchedulerOperations[Type]["input"];
    };
  }["cron.schedulerStart" | "cron.schedulerTick" | "cron.schedulerRefresh"],
): CronSchedulerResult {
  const { input } = command;
  const key = JSON.stringify([database.path, input.storeKey]);
  let actor = actors.get(key);
  const starting = !actor && command.type === "cron.schedulerStart";
  if (!actor && command.type !== "cron.schedulerStart") {
    return emptyResult();
  }
  if (!actor) {
    actor = { storeKey: input.storeKey, databasePath: database.path, channels: new Map() };
    actors.set(key, actor);
  }
  if (command.type === "cron.schedulerStart" && !actor.channels.has(command.input.channelName)) {
    const channel = new BroadcastChannel(command.input.channelName);
    channel.unref();
    actor.channels.set(command.input.channelName, { channel, paused: false });
  }
  if (command.type !== "cron.schedulerStart" && command.input.channelName) {
    const subscriber = actor.channels.get(command.input.channelName);
    if (subscriber && command.input.paused !== undefined) {
      subscriber.paused = command.input.paused;
    }
  }
  const snapshot = input.snapshot
    ? installCronSchedulerSnapshot(input.storeKey, input.snapshot, database.path)
    : getCronSchedulerSnapshot(input.storeKey, database.path);
  if (!snapshot) {
    throw new Error("Cron scheduler requires a configuration snapshot");
  }
  const nowMs =
    input.nowMs ??
    (command.type === "cron.schedulerRefresh" ? command.input.options?.nowMs : undefined) ??
    Date.now();
  const monotonicMs = input.monotonicMs ?? performance.now();
  const elapsedWallMs = actor.lastWallMs === undefined ? 0 : nowMs - actor.lastWallMs;
  const elapsedMonotonicMs =
    actor.lastMonotonicMs === undefined ? 0 : monotonicMs - actor.lastMonotonicMs;
  const forwardJump =
    elapsedWallMs > MAX_CRON_TIMER_DELAY_MS + MIN_REFIRE_GAP_MS ||
    elapsedWallMs - elapsedMonotonicMs > MIN_REFIRE_GAP_MS;
  const result = emptyResult();
  if (
    snapshot.config.cronEnabled &&
    (command.type === "cron.schedulerRefresh" ||
      [...actor.channels.values()].some(({ paused }) => !paused))
  ) {
    let candidates: CronJob[] = [];
    if (starting || (command.type === "cron.schedulerTick" && forwardJump)) {
      candidates = boundedCatchup(
        database,
        input.storeKey,
        snapshot,
        nowMs,
        result,
        command.type === "cron.schedulerStart" ? command.input : undefined,
      );
    } else if (command.type !== "cron.schedulerRefresh") {
      candidates = readJobs(database, input.storeKey).filter((job) =>
        isRunnableJob({ job, nowMs, activeInProcess: false }),
      );
    }
    const ownerless = candidates.filter(
      (job) => !tryResolveCronJobEffectiveAgentId(job, snapshot.config.defaultAgentId),
    );
    if (ownerless.length > 0) {
      const skipped = recordSkippedCronRunsInWorker(
        database,
        {
          storeKey: input.storeKey,
          change: {
            kind: "ownerless",
            proposals: ownerless.map((job) => ({
              jobId: job.id,
              enabled: job.enabled,
              configRevision: resolveCronJobConfigRevision(job),
              nextRunAtMs: job.state.nextRunAtMs,
              lastRunAtMs: job.state.lastRunAtMs,
              lastRunStatus: job.state.lastRunStatus,
            })),
          },
          snapshot: {
            nowMs,
            defaultAgentId: snapshot.config.defaultAgentId,
            cronConfig: snapshot.config.cronConfig,
            notificationRouting: { defaultAgentId: snapshot.config.defaultAgentId },
            ownership: [],
          },
        },
        { recordHistory: true },
      ).outcome;
      collectChanges(result, skipped);
      result.ownerless.push(...skipped.jobs);
    }
    const owned = candidates.filter(
      (job) => !ownerless.includes(job) && hasScheduledNextRunAtMs(job.state.nextRunAtMs),
    );
    if (owned.length > 0) {
      const requested = requestCronRunsInWorker(database, {
        storeKey: input.storeKey,
        nowMs,
        defaultAgentId: snapshot.config.defaultAgentId,
        requests: owned.map((job) => ({
          mode: "scheduled",
          jobId: job.id,
          configRevision: resolveCronJobConfigRevision(job),
          scheduledSlotMs: job.state.nextRunAtMs,
          receiptId: createCronScheduledRunId(input.storeKey, job.id, job.state.nextRunAtMs!),
        })),
      });
      result.accepted.push(...requested.accepted);
      result.rejected.push(...requested.rejected);
      result.jobs.push(...requested.accepted.map((entry) => entry.job));
    }
    // Due work is selected before maintenance; backward clock movement never
    // recomputes a valid future deadline or rewinds an already-consumed slot.
    const options = {
      recomputeExpired: true,
      repairFutureCronNextRunAtMs: false,
      ...(command.type === "cron.schedulerRefresh" ? command.input.options : undefined),
    };
    if (
      readJobs(database, input.storeKey).some((job) =>
        needsCronTimerMaintenance(job, nowMs, options),
      )
    ) {
      collectChanges(
        result,
        scheduleUnownedCronJobsInWorker(database, {
          storeKey: input.storeKey,
          options,
          snapshot: { nowMs },
        }).outcome,
      );
    }
  }
  result.jobs = [...new Map(result.jobs.map((job) => [job.id, job])).values()];
  result.nextWakeAtMs = armActor(
    input.storeKey,
    actor,
    snapshot,
    readJobs(database, input.storeKey),
    nowMs,
  );
  if (command.type !== "cron.schedulerRefresh") {
    actor.lastWallMs = nowMs;
    actor.lastMonotonicMs = monotonicMs;
  }
  return result;
}

export function stopCronSchedulerInWorker(
  input: CronSchedulerOperations["cron.schedulerStop"]["input"],
): void {
  const entry = [...actors].find(
    ([, actor]) => actor.storeKey === input.storeKey && actor.channels.has(input.channelName),
  );
  if (!entry) {
    return;
  }
  const [key, actor] = entry;
  actor.channels.get(input.channelName)?.channel.close();
  actor.channels.delete(input.channelName);
  if (actor.channels.size === 0) {
    clearTimeout(actor.timer);
    actors.delete(key);
    removeCronSchedulerSnapshot(input.storeKey, actor.databasePath);
  }
}
