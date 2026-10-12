import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readResolvedSessionStoreTargetsInWorker } from "../../config/sessions/session-accessor.entry-read-runtime.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.entry.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type {
  ResolvedSessionEntryAccessTarget,
  ResolvedSessionEntryStoreTarget,
} from "../../config/sessions/session-accessor.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveSessionWorkerPlacementContext,
  type SessionWorkerPlacementContext,
} from "../../gateway/session-worker-placement-context.js";
import { prepareSessionWorkerPlacementMutationCheck } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import { WorktreeRemovalLockError } from "./removal-errors.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeOwnerKind } from "./types.js";

export function createManagedWorktreeOwnerPolicy(
  cfg: OpenClawConfig,
  now: () => number = Date.now,
): Required<
  Pick<WorktreeCleanupOwnerPolicy, "prepareOwners" | "readOwnerState" | "withOwnerCleanup">
> {
  const placementChecks = new Map<string, { sessionId?: string; assertCurrent: () => void }>();
  let preparedOwners = new Map<string, ResolvedSessionEntryStoreTarget>();
  const cleanupOwner = new AsyncLocalStorage<{
    ownerId: string;
    target: ResolvedSessionEntryAccessTarget;
    assertCurrent: () => void;
    lifecycleHeld?: boolean;
  }>();
  const state = (
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
    prepared?: {
      target: ResolvedSessionEntryAccessTarget;
      context: SessionWorkerPlacementContext;
      checks: typeof placementChecks;
    },
  ) => {
    if (ownerKind !== "session") {
      return "other";
    }
    try {
      const cleanup = cleanupOwner.getStore();
      const ownsCleanup = cleanup?.ownerId === ownerId;
      if (ownsCleanup) {
        cleanup.assertCurrent();
      }
      const target =
        prepared?.target ??
        (ownsCleanup ? cleanup.target : preparedOwners.get(ownerId)) ??
        (isIncognitoSessionKey(ownerId)
          ? resolveSessionEntryAccessTarget(
              { cfg, sessionKey: ownerId },
              { projection: "worktree" },
            )
          : undefined);
      if (!target) {
        return "active";
      }
      const entry = target.entry;
      const activityAt = Math.max(entry?.lastInteractionAt ?? 0, entry?.updatedAt ?? 0);
      if (entry?.archivedAt === undefined && activityAt > 0 && now() - activityAt <= IDLE_GC_MS) {
        return "active";
      }
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const identities = [target.canonicalKey, ownerId, entry?.sessionId];
      if (
        isSessionWorkAdmissionActive(scope, identities) ||
        (!(ownsCleanup && cleanup.lifecycleHeld) &&
          isSessionLifecycleMutationActive(scope, identities))
      ) {
        return "active";
      }
      const placementCheckCache = prepared?.checks ?? placementChecks;
      let placementCheck = placementCheckCache.get(target.canonicalKey);
      if (placementCheck && placementCheck.sessionId !== entry?.sessionId) {
        return "active";
      }
      if (!placementCheck) {
        const context = prepared?.context ?? resolveSessionWorkerPlacementContext();
        const store = context.workerSessionPlacementService;
        if (!store?.listForReconcile) {
          return "active";
        }
        // Missing session metadata cannot erase a durable remote worker's ownership.
        const related = () =>
          store.listForReconcile!(target.canonicalKey)
            .map((placement) => placement.sessionId)
            .toSorted();
        const initial = related();
        const checks = [
          ...new Set([...initial, ...(entry?.sessionId ? [entry.sessionId] : [])]),
        ].map((sessionId) => prepareSessionWorkerPlacementMutationCheck({ context, sessionId }));
        const assertCurrent = () => {
          if (JSON.stringify(related()) !== JSON.stringify(initial)) {
            throw new Error("worktree worker placement changed during cleanup");
          }
          for (const check of checks) {
            check();
          }
        };
        placementCheck = { sessionId: entry?.sessionId, assertCurrent };
        placementCheckCache.set(target.canonicalKey, placementCheck);
      }
      placementCheck.assertCurrent();
      return !entry || entry.archivedAt !== undefined ? "retired" : "idle";
    } catch {
      // GC is destructive. Unknown session state must defer cleanup instead of
      // turning a transient owner lookup failure into worktree removal.
      return "active";
    }
  };
  // Census facts classify one pass; cleanup retains its own receipt-backed owner predicate.
  return {
    prepareOwners: async (records) => {
      preparedOwners = new Map();
      const ownerIds = [
        ...new Set(
          records.flatMap((record) =>
            record.removedAt === undefined && record.ownerKind === "session" && record.ownerId
              ? [record.ownerId]
              : [],
          ),
        ),
      ];
      const states = new Map<string, ReturnType<typeof state>>();
      try {
        const context = resolveSessionWorkerPlacementContext();
        if (!context.workerSessionPlacementService?.listAsync) {
          throw new Error("Worker placement census is unavailable");
        }
        const [targets, placements] = await Promise.all([
          readResolvedSessionStoreTargetsInWorker({ cfg, sessionKeys: ownerIds }, "worktree"),
          context.workerSessionPlacementService.listAsync(),
        ]);
        preparedOwners = targets;
        const byId = new Map(placements.map((placement) => [placement.sessionId, placement]));
        const byKey = new Map<string, typeof placements>();
        for (const placement of placements) {
          if (placement.state !== "local" && placement.state !== "reclaimed") {
            const related = byKey.get(placement.sessionKey) ?? [];
            related.push(placement);
            byKey.set(placement.sessionKey, related);
          }
        }
        // Advisory facts never escape into the exact pre-mutation placement guards.
        const prepared = {
          checks: new Map<string, { sessionId?: string; assertCurrent: () => void }>(),
          context: {
            ...context,
            workerSessionPlacementService: {
              getMany: () => byId,
              listForReconcile: (key?: string) => byKey.get(key ?? "") ?? [],
            },
          },
        };
        for (const [index, id] of ownerIds.entries()) {
          if (index % 32 === 0) {
            await scheduler.yield();
          }
          const target = targets.get(id);
          states.set(id, target ? state("session", id, { ...prepared, target }) : "active");
        }
      } catch {
        // A failed census supplies no authority to remove a session-owned checkout.
      }
      return {
        readOwnerState: (kind, id) => (kind === "session" ? (states.get(id) ?? "active") : "other"),
      };
    },
    readOwnerState: (kind, id) => state(kind, id),
    withOwnerCleanup: async (record, run, signal) => {
      if (record.ownerKind !== "session" || !record.ownerId) {
        return await run((mutation) => mutation());
      }
      const ownerId = record.ownerId;
      const target =
        preparedOwners.get(ownerId) ??
        (
          await readResolvedSessionStoreTargetsInWorker({ cfg, sessionKeys: [ownerId] }, "worktree")
        ).get(ownerId);
      signal?.throwIfAborted();
      if (!target) {
        throw new WorktreeRemovalLockError("busy", "worktree owner could not be read for cleanup");
      }
      const scope = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
      const readScope = {
        agentId: target.agentId,
        sessionKey: target.storeKey,
        storePath: target.storePath,
        projection: "list" as const,
      };
      const matches = (before: SessionEntry | undefined, after: SessionEntry | undefined) =>
        before?.sessionId === after?.sessionId &&
        before?.lifecycleRevision === after?.lifecycleRevision &&
        before?.archivedAt === after?.archivedAt &&
        before?.updatedAt === after?.updatedAt &&
        before?.lastInteractionAt === after?.lastInteractionAt &&
        isDeepStrictEqual(before?.worktree, after?.worktree);
      let active = true;
      let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
      let acquiredRevision: number | undefined;
      let unregister = () => {};
      const release = () => {
        active = false;
        retained?.release();
        unregister();
      };
      const assertActive = () => {
        if (!active) {
          throw new WorktreeRemovalLockError("busy", "worktree cleanup owner was released");
        }
      };
      try {
        return await withSessionEntryReadOnlyInWorker(
          readScope,
          assertActive,
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            const entry = read.value;
            if (
              retained &&
              (acquiredRevision === undefined || !retained.acknowledge(entry, acquiredRevision))
            ) {
              throw new WorktreeRemovalLockError("busy", "worktree cleanup owner changed");
            }
            const assertCurrent = () => {
              assertActive();
              const nativeEntry = isIncognitoSessionKey(ownerId)
                ? resolveSessionEntryAccessTarget(
                    { cfg, sessionKey: ownerId },
                    { projection: "worktree" },
                  ).entry
                : undefined;
              if (
                isIncognitoSessionKey(ownerId)
                  ? !matches(entry, nativeEntry)
                  : !retained?.isCurrent()
              ) {
                throw new WorktreeRemovalLockError("busy", "worktree cleanup owner changed");
              }
            };
            const owner = { ownerId, target: { ...target, entry }, assertCurrent };
            const identities = [target.canonicalKey, ownerId, entry?.sessionId];
            // The removal claim protects Git work; only claim/publication holds session admission.
            return await cleanupOwner.run(owner, () =>
              run((mutation, options) =>
                runExclusiveSessionLifecycleMutation("worktree-cleanup", {
                  scope,
                  identities,
                  signal: options?.settle ? undefined : signal,
                  run: () => cleanupOwner.run({ ...owner, lifecycleHeld: true }, mutation),
                }),
              ),
            );
          },
          (database, identity) => {
            unregister = registerOpenClawAgentDatabaseAsyncResource({
              agentId: database.agentId,
              path: database.path,
              revoke: release,
              close: async () => release(),
            });
            retained = retainPreparedSessionEntryPredicate({
              databaseIdentity: identity.key,
              sessionKey: target.storeKey,
              entry: target.entry,
              matches,
            });
            acquiredRevision = retained.captureRevision();
          },
        );
      } finally {
        release();
      }
    },
  };
}
