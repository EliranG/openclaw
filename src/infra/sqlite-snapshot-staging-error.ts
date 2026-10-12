import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";

export function decodeSqliteSnapshotStagingError(
  payload: OpenClawStateWorkerErrorPayload | undefined,
): Error {
  const remote = new Error("SQLite snapshot staging failed");
  retainOpenClawStateWorkerErrorPayload(remote, payload);
  return hydrateOpenClawStateWorkerError(remote, { includeOrdinary: true });
}
