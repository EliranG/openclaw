import { AsyncLocalStorage } from "node:async_hooks";
import nodePath from "node:path";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
import {
  bindPreparedSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { retainSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseRuntime } from "../../state/openclaw-agent-db.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../../state/openclaw-agent-db.paths.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";

type WorkerTranscriptSourceIdentity = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "archivedAt"
>;

type WorkerTranscriptTurn = Pick<
  SessionPlacementTurnParams,
  "agentId" | "sessionId" | "sessionKey" | "sessionTarget"
>;

type PreparedWorkerTranscript = {
  target: BoundAgentRunSessionTarget;
  source: CapturedSessionEntryReadSource & { databaseIdentity: string };
  env: NodeJS.ProcessEnv;
  readCurrent: () => WorkerTranscriptSourceIdentity | undefined;
  assertCurrent: () => void;
  release: () => void | Promise<void>;
};

const preparedWorkerTranscript = new AsyncLocalStorage<PreparedWorkerTranscript>();

/** Keep receipt-published facts alive from the worker read through the final effect. */
async function prepareWorkerTranscript(
  target: BoundAgentRunSessionTarget,
  assertPreparing: () => void,
): Promise<PreparedWorkerTranscript> {
  let facts: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
  let source: PreparedWorkerTranscript["source"] | undefined;
  let prepared: PreparedWorkerTranscript | undefined;
  try {
    return await withSessionEntryReadOnlyInWorker(
      target,
      assertPreparing,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (!source || !facts || !owner.scope) {
          throw new Error("Cloud worker transcript has no durable source");
        }
        facts.initialize({
          entry: read.value && projectSessionSharingEntry(read.value),
          membership: new Set(),
        });
        const currentFacts = facts;
        const env = owner.scope.env ?? process.env;
        const retained = retainSessionHistoryWorkerDatabase({
          agentId: source.agentId,
          path: source.path,
          env,
        });
        let active = true;
        prepared = {
          target: { ...target, storePath: source.path },
          source,
          env,
          readCurrent: () => currentFacts.readCurrent()?.entry,
          assertCurrent: () => {
            if (!active) {
              throw new Error("Cloud worker transcript authority has been released");
            }
            retained.owner.assertCurrent();
          },
          release: () => {
            active = false;
            currentFacts.release();
            return retained.release();
          },
        };
        return prepared;
      },
      (database, identity) => {
        if (!identity.key.startsWith("file:")) {
          throw new Error("Cloud worker transcript has no durable source");
        }
        source = {
          agentId: database.agentId,
          path: database.path,
          databaseIdentity: identity.key.slice("file:".length),
          databaseBirthtime: identity.birthtime,
        };
        facts = retainPreparedSessionSharingFacts({
          databaseIdentity: identity.key,
          sessionKey: target.sessionKey,
          acquiring: true,
        });
      },
    );
  } catch (error) {
    if (prepared) {
      await releaseSessionSourceAuthorities([prepared], [error]);
    } else {
      facts?.release();
    }
    throw error;
  }
}

function findPreparedTranscript(target: BoundAgentRunSessionTarget) {
  const prepared = preparedWorkerTranscript.getStore();
  if (
    !prepared ||
    prepared.target.agentId !== target.agentId ||
    prepared.target.sessionKey !== target.sessionKey ||
    nodePath.resolve(prepared.target.storePath) !== nodePath.resolve(target.storePath)
  ) {
    return undefined;
  }
  return prepared;
}

function currentPreparedTranscript(target: BoundAgentRunSessionTarget) {
  const prepared = findPreparedTranscript(target);
  if (!prepared) {
    throw new Error("Cloud worker transcript requires prepared authority");
  }
  prepared.assertCurrent();
  return prepared;
}

function captureWorkerTurnTranscriptTarget(turn: WorkerTranscriptTurn): BoundAgentRunSessionTarget {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const targetKeyAgentId = parseAgentSessionKey(turn.sessionTarget.sessionKey)?.agentId;
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey) ||
    (targetKeyAgentId && targetKeyAgentId !== turn.sessionTarget.agentId)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
    expectedLifecycleRevision: turn.sessionTarget.expectedLifecycleRevision,
    expectedWriterRunId: turn.sessionTarget.expectedWriterRunId,
  };
}

export function resolveWorkerTurnTranscriptTarget(
  turn: WorkerTranscriptTurn,
): BoundAgentRunSessionTarget {
  const target = captureWorkerTurnTranscriptTarget(turn);
  const memory = getSessionActorStorageBinding(target);
  const binding = memory ? undefined : captureIncognitoSessionBinding(target);
  const currentEntry = memory
    ? memory.actor.snapshot(memory.authority)?.entry
    : binding
      ? binding.actor.sessions.readSharing(target.sessionKey)?.entry
      : resolveExplicitIncognitoAgentSqliteTarget(target.storePath, { agentId: target.agentId })
        ? loadSessionEntryReadOnly(target)
        : currentPreparedTranscript(target).readCurrent();
  if (
    currentEntry?.sessionId !== target.sessionId ||
    (target.expectedLifecycleRevision !== undefined &&
      currentEntry.lifecycleRevision !== target.expectedLifecycleRevision) ||
    (target.expectedWriterRunId !== undefined &&
      currentEntry.activeWriterRunId !== target.expectedWriterRunId)
  ) {
    throw new Error("Cloud worker transcript identity is no longer current");
  }
  return target;
}

/** Keep native compatibility guards on the worker-admitted handle through turn settlement. */
export async function withWorkerTurnTranscriptDatabase<T>(
  turn: WorkerTranscriptTurn,
  controls: {
    assertCurrent(): void;
    prepareAuthority(): Promise<Pick<PlacementTurnClaimAuthority, "isCurrent" | "release">>;
    signal?: AbortSignal;
  },
  run: (target: BoundAgentRunSessionTarget) => Promise<T>,
): Promise<T> {
  const captured = captureWorkerTurnTranscriptTarget(turn);
  const target = { ...captured, storePath: nodePath.resolve(captured.storePath) };
  const memory = getSessionActorStorageBinding(target);
  const binding = memory ? undefined : captureIncognitoSessionBinding(target);
  let executing = false;
  let authority: Awaited<ReturnType<typeof controls.prepareAuthority>> | undefined;
  const assertPreparing = () => {
    // Execution owns subsequent liveness and can settle after releasing its placement claim.
    if (executing) {
      return;
    }
    controls.signal?.throwIfAborted();
    if (authority && !authority.isCurrent()) {
      throw new Error("Cloud worker placement authority changed during preparation");
    }
    const current = captureWorkerTurnTranscriptTarget(turn);
    if (
      current.agentId !== target.agentId ||
      current.sessionId !== target.sessionId ||
      current.sessionKey !== target.sessionKey ||
      nodePath.resolve(current.storePath) !== target.storePath ||
      current.expectedLifecycleRevision !== target.expectedLifecycleRevision ||
      current.expectedWriterRunId !== target.expectedWriterRunId
    ) {
      throw new Error("Cloud worker transcript target changed during preparation");
    }
  };
  const runAdmitted = async (pinned: BoundAgentRunSessionTarget) => {
    controls.assertCurrent();
    const current = resolveWorkerTurnTranscriptTarget({ ...pinned, sessionTarget: pinned });
    executing = true;
    const originalSessionTarget = turn.sessionTarget;
    turn.sessionTarget = current;
    try {
      return await run(current);
    } finally {
      turn.sessionTarget = originalSessionTarget;
    }
  };
  controls.assertCurrent();
  if (memory) {
    authority = await controls.prepareAuthority();
    try {
      assertPreparing();
      return await runAdmitted(target);
    } finally {
      authority.release();
      authority = undefined;
    }
  }
  if (binding) {
    return binding.actor.sessions.withSharedState(async () => {
      await binding.actor.sessions.read(
        { assertCurrent: assertPreparing },
        { sessionKey: target.sessionKey },
        binding.admissionSignal,
      );
      binding.actor.assertReadable();
      assertPreparing();
      authority = await controls.prepareAuthority();
      try {
        binding.admissionSignal?.throwIfAborted();
        binding.actor.assertReadable();
        assertPreparing();
        return await runAdmitted(target);
      } finally {
        authority.release();
        authority = undefined;
      }
    });
  }
  if (resolveExplicitIncognitoAgentSqliteTarget(target.storePath, { agentId: target.agentId })) {
    return withSessionEntryReadOnlyInWorker(target, assertPreparing, async () => {
      authority = await controls.prepareAuthority();
      try {
        assertPreparing();
        return await runAdmitted(target);
      } finally {
        authority.release();
        authority = undefined;
      }
    });
  }
  const prepared = await prepareWorkerTranscript(target, assertPreparing);
  try {
    authority = await controls.prepareAuthority();
    try {
      controls.assertCurrent();
      const assertAdmission = () => {
        prepared.assertCurrent();
        assertPreparing();
      };
      return await withOpenClawAgentDatabaseRuntime(
        { agentId: prepared.source.agentId, path: prepared.source.path, env: prepared.env },
        () => {
          assertAdmission();
          return preparedWorkerTranscript.run(prepared, () => runAdmitted(prepared.target));
        },
        assertAdmission,
        controls.signal,
      );
    } finally {
      authority.release();
      authority = undefined;
    }
  } finally {
    await prepared.release();
  }
}

/** Reuse the accepted turn identity as a transaction-local source predicate. */
export function captureWorkerTurnTranscriptSource(
  target: BoundAgentRunSessionTarget,
  predicate?: {
    fields: (keyof WorkerTranscriptSourceIdentity)[];
    expected: WorkerTranscriptSourceIdentity;
    refuse: () => never;
  },
): SessionSourceAssertion {
  const memory = getSessionActorStorageBinding(target);
  const binding = memory ? undefined : captureIncognitoSessionBinding(target);
  const expected: WorkerTranscriptSourceIdentity = predicate
    ? { ...predicate.expected }
    : {
        sessionId: target.sessionId,
        ...(target.expectedLifecycleRevision !== undefined
          ? { lifecycleRevision: target.expectedLifecycleRevision }
          : {}),
        ...(target.expectedWriterRunId !== undefined
          ? { activeWriterRunId: target.expectedWriterRunId }
          : {}),
      };
  const fields: (keyof WorkerTranscriptSourceIdentity)[] = predicate
    ? [...predicate.fields]
    : (["sessionId", "lifecycleRevision", "activeWriterRunId"] as const).filter((field) =>
        Object.hasOwn(expected, field),
      );
  const refuse =
    predicate?.refuse ??
    ((): never => {
      throw new Error("Cloud worker transcript identity is no longer current");
    });
  const assertEntry = (entry: WorkerTranscriptSourceIdentity | undefined) => {
    if (!entry || fields.some((field) => entry[field] !== expected[field])) {
      refuse();
    }
  };
  if (memory) {
    return () => assertEntry(memory.actor.snapshot(memory.authority)?.entry);
  }
  if (binding) {
    const claim = binding.actor.sessions.captureCurrent(target.sessionKey);
    return () => {
      binding.admissionSignal?.throwIfAborted();
      binding.actor.assertReadable();
      claim.assertCurrent();
      assertEntry(binding.actor.sessions.readSharing(target.sessionKey)?.entry);
    };
  }
  if (resolveExplicitIncognitoAgentSqliteTarget(target.storePath, { agentId: target.agentId })) {
    return Object.assign(() => assertEntry(loadSessionEntryReadOnly(target)), {
      nativeSource: true,
    });
  }
  return Object.assign(() => assertEntry(currentPreparedTranscript(target).readCurrent()), {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      const current = findPreparedTranscript(target);
      const prepared = current ?? (await prepareWorkerTranscript(target, () => {}));
      try {
        const assertPrepared = () => {
          prepared.assertCurrent();
          assertEntry(prepared.readCurrent());
        };
        assertPrepared();
        return {
          assertCurrent: assertPrepared,
          checks: [
            {
              predicate: {
                source: prepared.source,
                sessionKey: target.sessionKey,
                fields,
                expected,
              },
              refuse,
            },
          ],
          release: current ? undefined : prepared.release,
        };
      } catch (error) {
        if (!current) {
          await releaseSessionSourceAuthorities([prepared], [error]);
        }
        throw error;
      }
    },
  });
}

/** Callers retaining a source outside a turn must own its prepared lifetime. */
export async function prepareWorkerTurnTranscriptSource(
  ...args: Parameters<typeof captureWorkerTurnTranscriptSource>
) {
  const source = captureWorkerTurnTranscriptSource(...args);
  const prepared = source.prepareSessionSource
    ? await source.prepareSessionSource()
    : { assertCurrent: source, checks: [], nativeSource: source.nativeSource };
  const retained = bindPreparedSessionSourceAssertion(source, prepared);
  return Object.assign(retained, { [Symbol.asyncDispose]: () => retained.release() });
}
