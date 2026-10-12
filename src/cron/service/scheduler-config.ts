import type { CronSchedulerSnapshot } from "../store/scheduler-actor.types.js";
import type { CronServiceState } from "./state.js";

let snapshotVersion = 0;

/** Resolve host-only configuration before submitting any worker command. */
export async function captureCronSchedulerSnapshot(
  state: CronServiceState,
  configuredChannels?: readonly string[],
): Promise<CronSchedulerSnapshot> {
  const channels = configuredChannels ?? (await state.deps.listConfiguredChannels?.());
  return {
    version: ++snapshotVersion,
    config: structuredClone({
      cronEnabled: state.deps.cronEnabled,
      cronConfig: state.deps.cronConfig,
      defaultAgentId: state.deps.resolveDefaultAgentId
        ? state.deps.resolveDefaultAgentId()
        : state.deps.defaultAgentId,
      configuredChannels: channels ? [...channels] : undefined,
      maxMissedJobsPerRestart: state.deps.maxMissedJobsPerRestart,
      missedJobStaggerMs: state.deps.missedJobStaggerMs,
      startupDeferredMissedAgentJobDelayMs: state.deps.startupDeferredMissedAgentJobDelayMs,
    }),
  };
}
