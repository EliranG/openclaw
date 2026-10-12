import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { retainPreparedSessionSharingFacts } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";

export async function prepareWorkerPlacementRepositoryManifestRefs(
  placement: WorkerSessionPlacementIdentity,
): Promise<(() => readonly string[] | null) & Disposable> {
  const memory = getSessionActorStorageBinding(placement);
  const metadata = memory ? undefined : captureSessionEntryMetadataRead(placement);
  const nativeIncognito = !memory && !metadata && isIncognitoSessionKey(placement.sessionKey);
  const scope = { ...placement, storePath: resolveSessionStorePathForScope(placement) };
  let retained: ReturnType<typeof retainPreparedSessionSharingFacts> | undefined;
  let unregister = () => {};
  let active = true;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    retained?.release();
    unregister();
  };
  try {
    const entry = memory
      ? memory.actor.snapshot(memory.authority)?.entry
      : metadata
        ? metadata.readCurrent()
        : nativeIncognito
          ? loadSessionEntryReadOnly(scope)
          : await withSessionEntryReadOnlyInWorker(
              scope,
              () => {},
              async (read) => {
                if (!read.ok) {
                  throw read.error;
                }
                retained?.initialize({
                  entry: read.value && projectSessionSharingEntry(read.value),
                  membership: new Set(),
                });
                return read.value;
              },
              (database, identity) => {
                if (!identity.key.startsWith("file:")) {
                  return;
                }
                retained = retainPreparedSessionSharingFacts({
                  databaseIdentity: identity.key,
                  sessionKey: placement.sessionKey,
                  acquiring: true,
                });
                unregister = registerOpenClawAgentDatabaseAsyncResource({
                  agentId: database.agentId,
                  path: database.path,
                  revoke: release,
                  close: async () => release(),
                });
              },
            );
    if (entry?.sessionId !== placement.sessionId) {
      release();
      return Object.assign(() => null, { [Symbol.dispose]: release });
    }
    const prepared = entry.repositoryWorkspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(entry.repositoryWorkspaceId)
      : undefined;
    return Object.assign(
      () => {
        if (!active) {
          return null;
        }
        const current = memory
          ? memory.actor.snapshot(memory.authority)?.entry
          : metadata
            ? metadata.readCurrent()
            : nativeIncognito
              ? loadSessionEntryReadOnly(scope)
              : retained?.readCurrent()?.entry;
        if (
          current?.sessionId !== placement.sessionId ||
          current.lifecycleRevision !== entry.lifecycleRevision ||
          current.repositoryWorkspaceId !== entry.repositoryWorkspaceId
        ) {
          return null;
        }
        if (!prepared) {
          return [];
        }
        try {
          const repository = prepared.current();
          // Cumulative exports still need the original checkout manifest after a turn.
          return repository?.agentId === placement.agentId &&
            repository.sessionKey === placement.sessionKey &&
            repository.baseManifestHash
            ? [repository.baseManifestHash]
            : null;
        } catch {
          // Unsettled or retired repository ownership cannot authorize manifest deletion.
          return null;
        }
      },
      { [Symbol.dispose]: release },
    );
  } catch (error) {
    release();
    throw error;
  }
}
