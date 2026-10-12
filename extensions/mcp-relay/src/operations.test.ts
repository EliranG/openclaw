import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequest } from "./gateway-request.js";
import { createOperations } from "./operations.js";

const newer = {
  key: "agent:main:new",
  sessionId: "new-session",
  agentId: "main",
  derivedTitle: "New conversation",
  lastMessagePreview: "Latest preview",
  run: "idle" as const,
  archived: false,
  pullRequests: [],
  lastActivityAt: 1_000,
};
const older = {
  ...newer,
  key: "agent:main:old",
  sessionId: "old-session",
  derivedTitle: "Older conversation",
  lastActivityAt: 500,
};

function fixture(agentId?: string, now = () => 0) {
  const request = vi.fn<GatewayRequest>();
  const describeSession = vi.fn<GatewayRequest>().mockResolvedValue({ session: newer });
  const listSessions = vi.fn<GatewayRequest>().mockResolvedValue({ sessions: [newer] });
  const agents = vi.fn<GatewayRequest>().mockResolvedValue({
    defaultId: "main",
    agents: [
      { id: "main", name: "Main agent" },
      { id: "research", name: "Research" },
    ],
  });
  // These are RPC response fixtures, not implementations of Gateway authorization.
  const boundRequest = vi.fn<GatewayRequest>(async (method, params, options) => {
    const handler =
      method === "sessions.describe"
        ? describeSession
        : method === "sessions.list"
          ? listSessions
          : method === "agents.list"
            ? agents
            : request;
    return handler(method, params, options);
  });
  const logger = { error: vi.fn() };
  const dispatch = createOperations({
    logger,
    agentId,
    now,
    gateway: { name: "Synthetic Gateway", version: "1.0.0" },
  });
  const operations = (op: string, params: unknown, assertAuthority = async () => {}) =>
    dispatch(op, params, assertAuthority, boundRequest);
  return { operations, request, describeSession, listSessions, agents, boundRequest, logger };
}

function message(id: string, role: string, text: string) {
  return { role, content: [{ type: "text", text }], timestamp: 1_000, __openclaw: { id } };
}

describe("MCP relay data operations", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("maps only the grant-bound RPC roster and session results to the wire", async () => {
    const { operations, listSessions } = fixture();
    expect(await operations("status", {})).toEqual({
      gateway: { name: "Synthetic Gateway", version: "1.0.0" },
      agents: [
        { id: "main", name: "Main agent", default: true },
        { id: "research", name: "Research", default: false },
      ],
    });
    expect(await operations("conversations.list", { limit: 1 })).toEqual({
      conversations: [
        {
          conversationId: newer.key,
          title: "New conversation",
          agentId: "main",
          updatedAt: "1970-01-01T00:00:01.000Z",
          preview: "Latest preview",
        },
      ],
    });
    listSessions.mockResolvedValueOnce({ sessions: [older] });
    expect(
      await operations("conversations.list", { limit: 50, search: "OLDER", agentId: "main" }),
    ).toMatchObject({ conversations: [{ conversationId: older.key }] });
    expect(listSessions).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", search: "OLDER", limit: 50 }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("anchors the first history page and preserves opaque older cursors with plain user/assistant text", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({ messages: [message("latest", "assistant", "answer")] });
    request.mockResolvedValueOnce({
      messages: [
        message("user", "user", "question"),
        message("tool", "toolResult", "secret tool output"),
        message("latest", "assistant", "answer"),
      ],
      olderCursor: "host-page-cursor",
    });
    expect(await operations("conversation.read", { conversationId: newer.key, limit: 3 })).toEqual({
      conversationId: newer.key,
      title: "New conversation",
      messages: [
        { id: "user", role: "user", text: "question", timestamp: "1970-01-01T00:00:01.000Z" },
        { id: "latest", role: "assistant", text: "answer", timestamp: "1970-01-01T00:00:01.000Z" },
      ],
      nextBefore: "host-page-cursor",
    });
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({
        sessionKey: newer.key,
        messageId: "latest",
        limit: 3,
        maxChars: 16_000,
      }),
      { signal: expect.any(AbortSignal) },
    );
    request.mockResolvedValueOnce({ messages: [message("prior", "user", "earlier")] });
    await operations("conversation.read", {
      conversationId: newer.key,
      limit: 3,
      before: "host-page-cursor",
    });
    expect(request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "host-page-cursor", limit: 3 }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("truncates plain text and rejects a result exceeding the wire byte cap", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      messages: [message("large", "assistant", "x".repeat(20_000))],
    });
    const result = await operations("conversation.read", {
      conversationId: newer.key,
      limit: 1,
      before: "cursor",
    });
    expect(result).toMatchObject({ messages: [{ text: `${"x".repeat(15_999)}…` }] });
    request.mockResolvedValueOnce({
      messages: Array.from({ length: 40 }, (_, i) =>
        message(`large-${i}`, "assistant", "x".repeat(16_000)),
      ),
    });
    await expect(
      operations("conversation.read", { conversationId: newer.key, limit: 40, before: "cursor" }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it.each(["missing", "FORBIDDEN", "INVALID_REQUEST"])(
    "reports a %s session lookup without disclosing whether it exists",
    async (response) => {
      const missing = fixture();
      if (response === "missing") {
        missing.describeSession.mockResolvedValue({ session: null });
      } else {
        missing.describeSession.mockRejectedValue(
          Object.assign(new Error("Hidden session"), {
            name: "GatewayClientRequestError",
            code: response,
            gatewayCode: response,
            retryable: false,
          }),
        );
      }
      await expect(
        missing.operations("conversation.read", { conversationId: "unknown", limit: 1 }),
      ).rejects.toMatchObject({
        code: "not_found",
        message: "Conversation not found. List conversations and select an existing conversation.",
      });
      expect(missing.request).not.toHaveBeenCalled();
    },
  );

  it("refuses rebound sessions and invalid history cursors", async () => {
    const rebound = fixture();
    rebound.describeSession
      .mockResolvedValueOnce({ session: newer })
      .mockResolvedValueOnce({ session: { ...newer, sessionId: "replacement" } });
    rebound.request.mockResolvedValueOnce({ messages: [message("old", "user", "old data")] });
    await expect(
      rebound.operations("conversation.read", {
        conversationId: newer.key,
        limit: 1,
        before: "cursor",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });

    const stale = fixture();
    stale.request.mockResolvedValueOnce({ kind: "reset" });
    await expect(
      stale.operations("conversation.read", {
        conversationId: newer.key,
        limit: 1,
        before: "stale",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it.each([
    ["status", { unexpected: true }],
    ["conversations.list", { limit: 0 }],
    ["conversations.list", { limit: 51 }],
    ["conversations.list", { limit: 1, search: "x".repeat(201) }],
    ["conversation.read", { conversationId: newer.key, limit: 101 }],
    ["conversation.read", { conversationId: "", limit: 1 }],
    ["message.send", { message: "x".repeat(8_001), waitMs: 0 }],
    ["message.send", { message: "hello", waitMs: -1 }],
    ["reply.get", { conversationId: newer.key, runId: "run", waitMs: 50_001 }],
  ])("validates %s parameters before reaching the SDK", async (op, params) => {
    const { operations, request, describeSession, listSessions } = fixture();
    await expect(operations(op, params)).rejects.toMatchObject({ code: "invalid_params" });
    expect(request).not.toHaveBeenCalled();
    expect(describeSession).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("submits a new conversation with agent precedence and returns its accepted run without waiting", async () => {
    const { operations, request } = fixture("research");
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "created-run",
      runStarted: true,
    });
    expect(
      await operations("message.send", { message: "new question", agentId: "main", waitMs: 0 }),
    ).toEqual({ conversationId: newer.key, runId: "created-run", status: "running" });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.create",
      { agentId: "main", message: "new question" },
      { signal: expect.any(AbortSignal) },
    );

    const configured = fixture("research");
    configured.request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "configured-run",
      runStarted: true,
    });
    await configured.operations("message.send", { message: "configured", waitMs: 0 });
    expect(configured.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ agentId: "research" }),
      expect.any(Object),
    );
  });

  it("continues an existing conversation and reads its exact completed reply", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({ runId: "accepted-run", status: "started" });
    request.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "snapshot text" },
    });
    expect(
      await operations("message.send", {
        message: "continue",
        conversationId: newer.key,
        waitMs: 50_000,
      }),
    ).toEqual({
      conversationId: newer.key,
      runId: "accepted-run",
      status: "completed",
      reply: "snapshot text",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.send",
      {
        sessionKey: newer.key,
        sessionId: newer.sessionId,
        agentId: "main",
        message: "continue",
        idempotencyKey: expect.any(String),
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      { runId: "accepted-run", timeoutMs: 50_000 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    {
      name: "visible reply",
      terminalReply: { disposition: "visible", text: "owner reply" },
      content: { reply: "owner reply" },
    },
    {
      name: "truncated reply",
      terminalReply: { disposition: "visible", text: "x".repeat(20_000) },
      content: { reply: `${"x".repeat(15_999)}…` },
    },
    { name: "silent reply", terminalReply: { disposition: "silent" }, content: {} },
    { name: "empty reply", terminalReply: { disposition: "empty" }, content: {} },
    {
      name: "expired reply",
      terminalReply: undefined,
      content: {
        error: "The reply is no longer available from the run. Use read_conversation to see it.",
      },
    },
  ])(
    "returns the run owner's $name without transcript reads",
    async ({ terminalReply, content }) => {
      const { operations, request } = fixture();
      request.mockResolvedValueOnce({ status: "ok", terminalReply });
      expect(
        await operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 0 }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "completed", ...content });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "agent.wait",
        { runId: "run", timeoutMs: 0 },
        { signal: expect.any(AbortSignal) },
      );
    },
  );

  it.each(["message.send", "reply.get"])("refuses a missing conversation for %s", async (op) => {
    const { operations, request, describeSession } = fixture();
    describeSession.mockResolvedValue({ session: null });
    await expect(
      operations(op, {
        conversationId: "missing",
        ...(op === "message.send" ? { message: "hello" } : { runId: "run" }),
        waitMs: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(request).not.toHaveBeenCalled();
  });

  it("withholds a reply if the conversation is deleted while waiting", async () => {
    const { operations, request, describeSession } = fixture();
    request.mockImplementationOnce(async () => {
      describeSession.mockResolvedValue({ session: null });
      return { status: "ok", terminalReply: { disposition: "visible", text: "deleted reply" } };
    });
    await expect(
      operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 100 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it.each([
    { name: "observation timeout", payload: { status: "timeout" }, expected: "running" },
    {
      name: "queued pending",
      payload: { status: "pending", timeoutPhase: "queue" },
      expected: "running",
    },
    {
      name: "retry-grace timeout",
      payload: { status: "timeout", endedAt: 100, pendingError: true },
      expected: "running",
    },
    {
      name: "terminal timestamp",
      payload: { status: "timeout", endedAt: 100 },
      expected: "failed",
    },
    {
      name: "terminal reason",
      payload: { status: "timeout", stopReason: "restart" },
      expected: "failed",
    },
    {
      name: "terminal liveness",
      payload: { status: "timeout", livenessState: "blocked" },
      expected: "failed",
    },
    {
      name: "hard provider timeout",
      payload: { status: "timeout", timeoutPhase: "provider" },
      expected: "failed",
    },
    {
      name: "provider-started timeout",
      payload: { status: "timeout", providerStarted: true },
      expected: "failed",
    },
    { name: "terminal failure", payload: { status: "error" }, expected: "failed" },
  ])(
    "maps $name without approval inference or exposing host errors",
    async ({ payload, expected }) => {
      const { operations, request } = fixture();
      request.mockResolvedValueOnce({ runId: "run", status: "started" });
      request.mockResolvedValueOnce({ ...payload, error: "sensitive internal failure" });
      const result = await operations("message.send", {
        conversationId: newer.key,
        message: "hello",
        waitMs: 100,
      });
      expect(result).toMatchObject({ status: expected });
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(JSON.stringify(result)).not.toContain("waiting_for_approval");
    },
  );

  it("rechecks grant authority after session preparation and before submission", async () => {
    const { operations, request, describeSession } = fixture();
    let authorized = true;
    describeSession.mockImplementationOnce(async () => {
      authorized = false;
      return { session: newer };
    });
    const assertAuthority = async () => {
      if (!authorized) {
        throw new Error("grant revoked");
      }
    };
    await expect(
      operations(
        "message.send",
        { conversationId: newer.key, message: "hello", waitMs: 0 },
        assertAuthority,
      ),
    ).rejects.toThrow("grant revoked");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["status", "conversations.list"])(
    "withholds %s metadata if grant authority is revoked during the RPC",
    async (op) => {
      const { operations, agents, listSessions } = fixture();
      let authorized = true;
      (op === "status" ? agents : listSessions).mockImplementationOnce(async () => {
        authorized = false;
        return op === "status"
          ? { defaultId: "main", agents: [{ id: "main", name: "Private agent" }] }
          : { sessions: [newer] };
      });
      await expect(
        operations(op, op === "status" ? {} : { limit: 1 }, async () => {
          if (!authorized) {
            throw new Error("grant revoked");
          }
        }),
      ).rejects.toThrow("grant revoked");
    },
  );

  it("withholds the run result if authority is revoked while waiting", async () => {
    const { operations, request } = fixture();
    let authorized = true;
    request
      .mockResolvedValueOnce({ runId: "run", status: "started" })
      .mockImplementationOnce(async () => {
        authorized = false;
        return { status: "ok" };
      });
    const assertAuthority = async () => {
      if (!authorized) {
        throw new Error("grant revoked");
      }
    };
    await expect(
      operations(
        "message.send",
        { conversationId: newer.key, message: "hello", waitMs: 1 },
        assertAuthority,
      ),
    ).rejects.toThrow("grant revoked");
  });

  it("reports a created conversation whose initial message failed without inventing a run", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runStarted: false,
      runError: { message: "private host error" },
    });
    await expect(operations("message.send", { message: "hello", waitMs: 0 })).rejects.toMatchObject(
      {
        code: "unavailable",
        message: expect.stringContaining("was created, but the message did not start"),
      },
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("returns the initial reply of a new conversation", async () => {
    const { operations, request } = fixture();
    request.mockResolvedValueOnce({
      key: newer.key,
      sessionId: newer.sessionId,
      runId: "created-run",
      runStarted: true,
    });
    request.mockResolvedValueOnce({
      status: "ok",
      terminalReply: { disposition: "visible", text: "created answer" },
    });
    expect(await operations("message.send", { message: "start", waitMs: 100 })).toEqual({
      conversationId: newer.key,
      runId: "created-run",
      status: "completed",
      reply: "created answer",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([20_000, 65_000])(
    "keeps an accepted run when preparation consumes %ims of its request budget",
    async (elapsed) => {
      let now = 0;
      const { operations, request } = fixture(undefined, () => now);
      request
        .mockImplementationOnce(async () => {
          now = elapsed;
          return { runId: "run", status: "started" };
        })
        .mockResolvedValueOnce({ status: "pending" });
      expect(
        await operations("message.send", {
          conversationId: newer.key,
          message: "start",
          waitMs: 50_000,
        }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "running" });
      if (elapsed < 65_000) {
        expect(request).toHaveBeenNthCalledWith(
          2,
          "agent.wait",
          { runId: "run", timeoutMs: 44_000 },
          { signal: expect.any(AbortSignal) },
        );
      } else {
        expect(request).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(["CLIENT_TIMEOUT", "AGENT_TIMEOUT", "elapsed"])(
    "preserves accepted run IDs after a %s RPC timeout",
    async (failure) => {
      let now = 0;
      const { operations, request } = fixture(undefined, () => now);
      request
        .mockResolvedValueOnce({ runId: "run", status: "started" })
        .mockImplementationOnce(async () => {
          if (failure === "elapsed") {
            now = 5_100;
            throw new Error("opaque host timeout");
          }
          throw Object.assign(new Error("opaque SDK timeout"), { code: failure });
        });
      expect(
        await operations("message.send", {
          conversationId: newer.key,
          message: "hello",
          waitMs: 100,
        }),
      ).toEqual({ conversationId: newer.key, runId: "run", status: "running" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves non-timeout SDK failures after run acceptance", async () => {
    const { operations, request } = fixture();
    const failure = Object.assign(new Error("request rejected"), { code: "INVALID_REQUEST" });
    request
      .mockResolvedValueOnce({ runId: "run", status: "started" })
      .mockRejectedValueOnce(failure);
    await expect(
      operations("message.send", { conversationId: newer.key, message: "hello", waitMs: 100 }),
    ).rejects.toBe(failure);
  });

  it("aborts an elapsed grant-bound RPC and preserves its accepted run ID", async () => {
    vi.useFakeTimers();
    const { operations, request } = fixture();
    let waiting!: () => void;
    const enteredWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    request.mockResolvedValueOnce({ runId: "run", status: "started" });
    request.mockImplementationOnce(async (_method, _params, options) => {
      const signal = options!.signal!;
      waiting();
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("RPC aborted"));
          },
          { once: true },
        );
      });
    });
    const result = operations("message.send", {
      conversationId: newer.key,
      message: "hello",
      waitMs: 100,
    });
    await enteredWait;
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(result).resolves.toEqual({
      conversationId: newer.key,
      runId: "run",
      status: "running",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["message.send", "conversation.read"])(
    "logs a %s Gateway failure once without request content",
    async (op) => {
      const { operations, request, logger } = fixture();
      const privateText = 'maintain the DISTINCTIVE "private request text"\nfor launch';
      const failure = Object.assign(
        new Error(
          `request rejected: ${privateText}; encoded: ${JSON.stringify(privateText).slice(1, -1)}\ntry again`,
        ),
        {
          code: "INVALID_REQUEST",
          details: {
            transcript: "PRIVATE transcript",
            token: "PRIVATE token",
            pairingCode: "ABCDE-FGHIJ",
          },
        },
      );
      request.mockRejectedValueOnce(failure);
      await expect(
        operations(
          op,
          op === "message.send"
            ? { agentId: "main", message: privateText, waitMs: 0 }
            : { conversationId: newer.key, before: privateText, limit: 1 },
        ),
      ).rejects.toBeDefined();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        `mcp-relay: op=${op} method=${op === "message.send" ? "sessions.create" : "chat.history"} INVALID_REQUEST: request rejected: [redacted]; encoded: [redacted] try again`,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /DISTINCTIVE|PRIVATE|ABCDE-FGHIJ/,
      );
    },
  );

  it("logs failed session lookup RPCs without dumping error details", async () => {
    const { operations, describeSession, logger } = fixture();
    const failure = new Error("session lookup unavailable");
    describeSession.mockRejectedValueOnce(failure);
    await expect(
      operations("reply.get", { conversationId: newer.key, runId: "run", waitMs: 0 }),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "mcp-relay: op=reply.get method=sessions.describe unknown: session lookup unavailable",
    );
  });
});
