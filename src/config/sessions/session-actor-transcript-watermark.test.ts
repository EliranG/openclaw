import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { loadAgentTranscriptReadOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withActor, type Mutation } from "./session-actor-worker.test-support.js";

// mock-isolation: The fixture owns storage lifetime without background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it("reads the committed append watermark and invalidates cold-state facts through the owning worker", async () => {
  await withActor(async (f) => {
    const before = f.read();
    const operations = await loadAgentTranscriptReadOperations();
    const expectedIdentity = readDatabasePathIdentitySync(f.database.path);
    const context: AgentWorkerOperationContext = {
      open: () => f.database,
      options: { agentId: "main", path: f.database.path },
      admit() {},
      writeTransaction() {
        throw new Error("Transcript reads cannot acquire a writer");
      },
    };
    const watermark = () =>
      operations["session.transcript.watermark.read"](
        { expectedIdentity, scope: f.scope },
        context,
      );
    expect(watermark()).toEqual({ ok: true, value: { generation: null, maxSeq: null } });

    const append: Mutation = {
      type: "session.actor.appendTranscriptEvent",
      input: {
        target: f.target,
        expected: before.version,
        commandId: "append-watermark",
        phaseId: "input",
        sessionId: f.scope.sessionId,
        lifecycleRevision: null,
        eventJson: JSON.stringify({
          type: "model_change",
          id: "appended",
          parentId: null,
          provider: "synthetic",
          modelId: "test-model",
        }),
      },
    };
    await f.prepare(append);
    expect(f.mutate(append).kind).toBe("committed");
    const reads = trackSqliteStatementExecutions(f.database.db, ["select"], (sql) =>
      /^select\b/iu.test(sql) ? "select" : null,
    );
    try {
      expect(watermark()).toMatchObject({ ok: true, value: { maxSeq: 0 } });
      expect(reads.counts.select).toBe(0);
      runSqliteImmediateTransactionSync(f.database.db, () => {
        f.database.db
          .prepare(
            `INSERT INTO session_transcript_cold_archives
             (session_id, generation, archive_name, archive_sha256, event_count,
              raw_bytes, archive_bytes, last_seq, archived_at, storage)
             VALUES (?, 'archive-generation', 'synthetic', ?, 42, 0, 0, 41, 1, 'file')`,
          )
          .run(f.scope.sessionId, "0".repeat(64));
      });
      // A native writer invalidates residency; the next read must see its retained frontier.
      expect(watermark()).toMatchObject({ ok: true, value: { maxSeq: 41 } });
      f.read();
      const beforeColdReads = reads.counts.select;
      expect(
        operations["session.transcript.coldMetadata.read"](
          { expectedIdentity, sessionId: f.scope.sessionId },
          context,
        ),
      ).toMatchObject({ ok: true, value: { last_seq: 41 } });
      expect(watermark()).toMatchObject({ ok: true, value: { maxSeq: 41 } });
      expect(reads.counts.select).toBe(beforeColdReads);

      runSqliteImmediateTransactionSync(f.database.db, () => {
        f.database.db
          .prepare("DELETE FROM session_transcript_cold_archives WHERE session_id = ?")
          .run(f.scope.sessionId);
      });
      expect(watermark()).toMatchObject({ ok: true, value: { maxSeq: 0 } });
      f.read();
      const beforeHotReads = reads.counts.select;
      expect(
        operations["session.transcript.coldMetadata.read"](
          { expectedIdentity, sessionId: f.scope.sessionId },
          context,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(reads.counts.select).toBe(beforeHotReads);
    } finally {
      reads.restore();
    }
  });
});
