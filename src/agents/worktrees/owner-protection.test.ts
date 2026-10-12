import "../../test-utils/prepare-compiled-subprocesses.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionReads from "../../config/sessions/session-accessor.entry-read-runtime.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { ResolvedSessionEntryStoreTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  getMany: vi.fn(),
  listForReconcile: vi.fn(),
  listAsync: vi.fn(),
  isSessionWorkAdmissionActive: vi.fn(),
  isSessionLifecycleMutationActive: vi.fn(),
  runExclusiveSessionLifecycleMutation: vi.fn(),
}));

const cleanupRecord = {
  id: "worktree",
  name: "archived",
  repoFingerprint: "repository",
  repoRoot: "/repository",
  path: "/worktree",
  branch: "archived",
  baseRef: "main",
  ownerKind: "session",
  ownerId: "agent:main:archived",
  createdAt: 1,
  lastActiveAt: 1,
} satisfies ManagedWorktreeRecord;

// mock-isolation: Each policy receives fixture placements instead of the process-wide Gateway store.
vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: mocks.getMany,
      listForReconcile: mocks.listForReconcile,
      listAsync: mocks.listAsync,
    },
  }),
}));
vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>()),
  isSessionWorkAdmissionActive: mocks.isSessionWorkAdmissionActive,
  isSessionLifecycleMutationActive: mocks.isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation: mocks.runExclusiveSessionLifecycleMutation,
}));

let state: OpenClawTestState;
let storePath: string;
const config = () => ({ session: { store: storePath } });
const archivedEntry = (): SessionEntry => ({
  sessionId: "session-one",
  updatedAt: 1,
  archivedAt: 1,
});
const writeEntry = (entry: SessionEntry, sessionKey = cleanupRecord.ownerId) =>
  replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
const preparePolicy = async (
  records: readonly ManagedWorktreeRecord[] = [cleanupRecord],
  now?: () => number,
) => {
  const policy = createManagedWorktreeOwnerPolicy(config(), now);
  await policy.prepareOwners(records);
  return policy;
};

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
});

beforeEach(() => {
  mocks.getMany.mockReset().mockReturnValue(new Map());
  mocks.listForReconcile.mockReset().mockReturnValue([]);
  mocks.listAsync.mockReset().mockResolvedValue([]);
  mocks.isSessionWorkAdmissionActive.mockReset().mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReset().mockReturnValue(false);
  mocks.runExclusiveSessionLifecycleMutation
    .mockReset()
    .mockImplementation((_operation, { run }: { run: () => Promise<unknown> }) => run());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await state.cleanup();
});

describe("createManagedWorktreeOwnerPolicy", () => {
  it("classifies a large census without caller-thread SQL and rechecks placements before removal", async () => {
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env: state.env }),
    });
    const records = Array.from({ length: 609 }, (_, index) => ({
      ...cleanupRecord,
      id: `worktree-${index}`,
      ownerId: `agent:main:census-${index}`,
    }));
    const targets = new Map<string, ResolvedSessionEntryStoreTarget>(
      records.map(({ ownerId }) => [
        ownerId,
        {
          agentId: "main",
          canonicalKey: ownerId,
          requestedKey: ownerId,
          storeKey: ownerId,
          storePath,
          entry: { sessionId: ownerId, updatedAt: 1, archivedAt: 1 },
        },
      ]),
    );
    vi.spyOn(sessionReads, "readResolvedSessionStoreTargetsInWorker").mockResolvedValueOnce(
      targets,
    );
    mocks.getMany.mockImplementation((ids) => store.getMany(ids));
    mocks.listForReconcile.mockImplementation((key) => store.listForReconcile(key));
    mocks.listAsync.mockImplementation(() => store.listAsync());
    const live = records[0]!.ownerId;
    await store.startDispatch({ sessionId: live, sessionKey: live, agentId: "main" });
    const policy = createManagedWorktreeOwnerPolicy(config());
    const sql = observeHostDataSql();
    try {
      const census = await policy.prepareOwners(records);
      expect(census.readOwnerState?.("session", live)).toBe("active");
      for (const record of records.slice(1)) {
        expect(census.readOwnerState?.("session", record.ownerId)).toBe("retired");
      }
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    const changed = records[1]!.ownerId;
    await store.startDispatch({ sessionId: changed, sessionKey: changed, agentId: "main" });
    expect(policy.readOwnerState("session", changed)).toBe("active");
  });

  it("cancels queued cleanup before the preceding session mutation finishes", async ({
    signal,
  }) => {
    const lifecycle = await vi.importActual<
      typeof import("../../sessions/session-lifecycle-admission.js")
    >("../../sessions/session-lifecycle-admission.js");
    mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
      lifecycle.runExclusiveSessionLifecycleMutation,
    );
    await writeEntry(archivedEntry());
    const policy = await preparePolicy();
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = lifecycle.runExclusiveSessionLifecycleMutation("archive", {
      scope: storePath,
      identities: [cleanupRecord.ownerId, "session-one"],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const remove = vi.fn(async () => {});
    const abort = new AbortController();
    const reason = new Error("worktree maintenance stopped");
    let pending: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      pending = policy.withOwnerCleanup(
        cleanupRecord,
        (withOwnerMutation) => withOwnerMutation(remove),
        abort.signal,
      );
      abort.abort(reason);
      await expect(withinTest(pending, signal)).rejects.toBe(reason);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, pending]);
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("exempts only its own session cleanup fence while preserving work admission protection", async () => {
    await writeEntry(archivedEntry());
    const policy = await preparePolicy();
    mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
    expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
    await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("retired");
        expect(policy.readOwnerState("session", `${cleanupRecord.ownerId}:other`)).toBe("active");
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
        expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
      }),
    );
    mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
    expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
  });

  it.each([
    { sessionId: "replacement" },
    { lifecycleRevision: "replacement" },
    { archivedAt: 2 },
    { updatedAt: 2 },
    { lastInteractionAt: 2 },
    { worktree: { id: "replacement", branch: "replacement", repoRoot: "/replacement" } },
  ])("rejects changed session custody after waiting for cleanup admission: %j", async (change) => {
    const entry: SessionEntry = {
      ...archivedEntry(),
      lifecycleRevision: "original",
      worktree: { id: cleanupRecord.id, branch: cleanupRecord.branch, repoRoot: "/repository" },
    };
    await writeEntry(entry);
    const policy = await preparePolicy();
    mocks.runExclusiveSessionLifecycleMutation.mockImplementationOnce(
      async (_operation, { run }: { run: () => Promise<unknown> }) => {
        await writeEntry({ ...entry, ...change });
        return await run();
      },
    );
    const sql = observeHostDataSql();
    try {
      await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
        withOwnerMutation(async () => {
          expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
        }),
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("protects only recently active session owners after the worker census", async () => {
    const now = 1_800_000_000_000;
    await writeEntry(
      { sessionId: "live", updatedAt: 1, lastInteractionAt: now - 1_000 },
      "agent:main:live",
    );
    await writeEntry({ sessionId: "stale", updatedAt: now - IDLE_GC_MS - 1 }, "agent:main:stale");
    await writeEntry(
      { sessionId: "archived", updatedAt: now, archivedAt: now },
      "agent:main:recently-archived",
    );
    const keys = [
      "agent:main:live",
      "agent:main:stale",
      "agent:main:recently-archived",
      "agent:main:absent",
    ];
    const policy = await preparePolicy(
      keys.map((ownerId) => ({ ...cleanupRecord, ownerId })),
      () => now,
    );
    expect(policy.readOwnerState("session", keys[0]!)).toBe("active");
    expect(policy.readOwnerState("session", keys[1]!)).toBe("idle");
    expect(policy.readOwnerState("manual", keys[0]!)).toBe("other");
    expect(policy.readOwnerState("session", keys[2]!)).toBe("retired");
    expect(policy.readOwnerState("session", keys[3]!)).toBe("retired");
    expect(policy.readOwnerState("manual", keys[3]!)).toBe("other");
  });

  it("shares one census and refuses a session reactivated before cleanup preparation", async () => {
    await writeEntry(archivedEntry());
    const policy = createManagedWorktreeOwnerPolicy(config());
    const censusRead = vi.spyOn(sessionReads, "readResolvedSessionStoreTargetsInWorker");
    const census = await policy.prepareOwners([
      cleanupRecord,
      { ...cleanupRecord, id: "second-checkout" },
    ]);
    expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("retired");
    await writeEntry({ sessionId: "session-one", updatedAt: Date.now() });
    const remove = vi.fn(async () => {});
    await expect(
      policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) => withOwnerMutation(remove)),
    ).rejects.toThrow("worktree cleanup owner changed");
    expect(remove).not.toHaveBeenCalled();
    expect(censusRead).toHaveBeenCalledTimes(1);
  });

  it("revokes retained cleanup callbacks on release and database close", async () => {
    await writeEntry(archivedEntry());
    const policy = await preparePolicy();
    let readReleased: (() => ReturnType<typeof policy.readOwnerState>) | undefined;
    await policy.withOwnerCleanup(cleanupRecord, async () => {
      readReleased = AsyncLocalStorage.bind(() =>
        policy.readOwnerState("session", cleanupRecord.ownerId),
      );
      expect(readReleased()).toBe("retired");
    });
    expect(readReleased!()).toBe("active");
    const observed = vi.fn();
    let closing: Promise<void> | undefined;
    const cleanup = policy.withOwnerCleanup(cleanupRecord, async () => {
      expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("retired");
      closing = closeOpenClawAgentDatabasesAsync();
      observed(policy.readOwnerState("session", cleanupRecord.ownerId));
    });
    try {
      await expect(cleanup).rejects.toThrow("worktree cleanup owner was released");
    } finally {
      await closing;
    }
    expect(observed).toHaveBeenCalledExactlyOnceWith("active");
  });

  it.each(["failed", "missing"])(
    "defers every session owner when the census is %s",
    async (result) => {
      const read = vi.spyOn(sessionReads, "readResolvedSessionStoreTargetsInWorker");
      if (result === "failed") {
        read.mockRejectedValueOnce(new Error("unavailable session store"));
      } else {
        read.mockResolvedValueOnce(new Map());
      }
      const census = await createManagedWorktreeOwnerPolicy(config()).prepareOwners([
        cleanupRecord,
      ]);
      expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("active");
      expect(census.readOwnerState?.("manual", cleanupRecord.ownerId)).toBe("other");
    },
  );

  it("defers unprepared session owners without attempting a synchronous read", () => {
    const policy = createManagedWorktreeOwnerPolicy(config());
    const sql = observeHostDataSql();
    try {
      expect(policy.readOwnerState("session", "agent:main:unprepared")).toBe("active");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("protects session owners when placement state cannot be read", async () => {
    await writeEntry(archivedEntry());
    const policy = await preparePolicy();
    mocks.listForReconcile.mockImplementation(() => {
      throw new Error("unreadable related placements");
    });
    expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
  });

  it.each(["admission", "lifecycle", "remote", "claimed", "unknown-placement"])(
    "protects retired session owners with %s work",
    async (kind) => {
      await writeEntry(archivedEntry());
      const policy = await preparePolicy();
      if (kind === "admission") {
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
      }
      if (kind === "lifecycle") {
        mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
      }
      if (kind === "unknown-placement") {
        mocks.getMany.mockImplementation(() => {
          throw new Error("unreadable placement");
        });
      }
      if (kind === "remote" || kind === "claimed") {
        mocks.getMany.mockReturnValue(
          new Map([
            [
              "session-one",
              {
                sessionId: "session-one",
                sessionKey: cleanupRecord.ownerId,
                state: kind === "remote" ? "active" : "local",
                generation: 1,
                ...(kind === "claimed" ? { turnClaim: { id: "active-turn" } } : {}),
              },
            ],
          ]),
        );
      }
      expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
    },
  );

  it("protects a missing session row with a cross-agent placement under its canonical key", async () => {
    const key = "agent:main:missing-placement";
    const policy = await preparePolicy([{ ...cleanupRecord, ownerId: key }]);
    const placement = {
      sessionId: "remote-session",
      sessionKey: key,
      agentId: "other",
      state: "active",
      generation: 1,
    };
    mocks.listForReconcile.mockImplementation((sessionKey?: string) =>
      sessionKey === undefined || sessionKey === key ? [placement] : [],
    );
    mocks.getMany.mockReturnValue(new Map([[placement.sessionId, placement]]));
    expect(policy.readOwnerState("session", key)).toBe("active");
  });

  it.each(["added", "removed", "unreadable"])(
    "invalidates cleanup when a related placement is %s but ignores unrelated changes",
    async (change) => {
      const key = `agent:main:missing-${change}`;
      const policy = await preparePolicy([{ ...cleanupRecord, ownerId: key }]);
      const placement = {
        sessionId: "stopped-session",
        sessionKey: key,
        agentId: "other",
        state: "failed",
        generation: 1,
        environmentId: null,
      };
      const placements = [placement];
      mocks.listForReconcile.mockImplementation((sessionKey?: string) =>
        placements.filter((record) => sessionKey === undefined || record.sessionKey === sessionKey),
      );
      mocks.getMany.mockImplementation(
        (sessionIds: readonly string[]) =>
          new Map(
            placements
              .filter((record) => sessionIds.includes(record.sessionId))
              .map((record) => [record.sessionId, record]),
          ),
      );
      expect(policy.readOwnerState("session", key)).toBe("retired");
      placements.push({ ...placement, sessionId: "unrelated", sessionKey: `${key}:child` });
      expect(policy.readOwnerState("session", key)).toBe("retired");
      if (change === "added") {
        placements.push({ ...placement, sessionId: "new-related" });
      } else if (change === "removed") {
        placements.splice(0, 1);
      } else {
        mocks.listForReconcile.mockImplementation(() => {
          throw new Error("unreadable related placements");
        });
      }
      expect(policy.readOwnerState("session", key)).toBe("active");
    },
  );

  it("invalidates cleanup when a stopped placement changes generation", async () => {
    await writeEntry(archivedEntry());
    const policy = await preparePolicy();
    const placement = {
      sessionId: "session-one",
      sessionKey: cleanupRecord.ownerId,
      state: "reclaimed",
      generation: 1,
    };
    mocks.getMany.mockReturnValue(new Map([[placement.sessionId, placement]]));
    expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("retired");
    mocks.getMany.mockReturnValue(
      new Map([[placement.sessionId, { ...placement, generation: 2 }]]),
    );
    expect(policy.readOwnerState("session", cleanupRecord.ownerId)).toBe("active");
  });
});
