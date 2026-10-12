import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteReadSnapshotSync,
} from "../../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { loadAgentTranscriptReadOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  readCurrentProjectionSnapshot,
  readSnapshotEventRows,
} from "./session-accessor.sqlite-projection-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { withSessionActorTranscriptRead } from "./session-actor-transcript-state.js";
import { withActor } from "./session-actor-worker.test-support.js";

// mock-isolation: The fixture owns storage lifetime without unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("uses resident projection facts only in prepared reads and keeps payloads in their SQL snapshot", async () => {
  await withActor(async (f) => {
    runSqliteImmediateTransactionSync(f.database.db, () =>
      appendTranscriptEventsInTransaction(f.database, f.scope, [
        {
          type: "session",
          id: f.scope.sessionId,
          version: 3,
          timestamp: "2026-01-01T00:00:00Z",
          cwd: "/synthetic",
        },
        { type: "message", id: "user", parentId: null, message: { role: "user", content: "body" } },
      ]),
    );
    f.read();
    const operations = await loadAgentTranscriptReadOperations();
    const identity = readDatabasePathIdentitySync(f.database.path);
    if (!identity.key.startsWith("file:")) {
      throw new Error("Projection fixture requires a file identity");
    }
    const context: AgentWorkerOperationContext = {
      open: () => f.database,
      options: { agentId: "main", path: f.database.path },
      admit() {},
      writeTransaction() {
        throw new Error("Projection reads must not acquire a write transaction");
      },
    };
    const resolved = { ...f.scope, path: f.database.path };
    const reads = trackSqliteStatementExecutions(f.database.db, ["projection", "payload"], (sql) =>
      sql.startsWith("select") && sql.includes('"reset_active"')
        ? "projection"
        : sql.startsWith("select") && sql.includes('"event"."event_json"')
          ? "payload"
          : null,
    );
    const readProjection = () =>
      readCurrentProjectionSnapshot(f.database, resolved, (projection) => ({
        indexedSeq: projection.state.indexedSeq,
        events: readSnapshotEventRows(projection, [1]),
      }));
    try {
      const result = operations["session.transcript.anchors.read"](
        {
          expectedIdentity: identity,
          resolved,
          selection: { entryIds: ["user"] },
        },
        context,
      );
      expect(result).toMatchObject({
        ok: true,
        value: { anchors: [{ entryId: "user", rawSeq: 1 }] },
      });
      expect(reads.counts.projection).toBe(0);
      const resident = runSqliteReadSnapshotSync(f.database.db, () =>
        withSessionActorTranscriptRead(f.database, f.scope.sessionId, readProjection),
      );
      expect(resident).toMatchObject({
        kind: "value",
        value: { indexedSeq: 1, events: [{ seq: 1 }] },
      });
      expect(reads.counts.projection).toBe(0);
      expect(reads.counts.payload).toBe(1);

      // A native snapshot does not borrow a live actor's view of an arbitrary snapshot.
      runSqliteReadSnapshotSync(f.database.db, readProjection);
      expect(reads.counts.projection).toBe(1);
      runSqliteImmediateTransactionSync(f.database.db, () =>
        appendTranscriptEventsInTransaction(f.database, f.scope, [
          {
            type: "message",
            id: "assistant",
            parentId: "user",
            message: { role: "assistant", content: "new body" },
          },
        ]),
      );
      const changed = runSqliteReadSnapshotSync(f.database.db, () =>
        withSessionActorTranscriptRead(f.database, f.scope.sessionId, readProjection),
      );
      expect(changed).toMatchObject({ kind: "value", value: { indexedSeq: 2 } });
      expect(reads.counts.projection).toBe(2);
    } finally {
      reads.restore();
    }
  });
});
