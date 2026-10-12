// Codex tests cover native execution policy plugin behavior.
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  prepareCodexNativeExecutionPolicy,
  resolveCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

const sessionStoreMocks = vi.hoisted(() => ({
  captureSessionEntryCurrentCheck: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-binding-runtime")>();
  return {
    ...actual,
    captureSessionEntryCurrentCheck: sessionStoreMocks.captureSessionEntryCurrentCheck,
  };
});

function mockSelectedEntry(entry: SessionEntry) {
  const release = vi.fn();
  sessionStoreMocks.captureSessionEntryCurrentCheck.mockResolvedValue({
    entry,
    isCurrent: () => true,
    assertCurrent() {},
    release,
  });
  onTestFinished(release);
}

describe("resolveCodexNativeExecutionPolicy", () => {
  beforeEach(() => {
    sessionStoreMocks.captureSessionEntryCurrentCheck.mockReset();
  });

  it("allows Codex native execution for gateway exec hosts", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
  });

  it("resolves auto to gateway when no sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "gateway",
    });
  });

  it("resolves auto to sandbox when a sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "sandbox",
    });
  });

  it("disables Codex native execution when exec host resolves to node", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
        sessionKey: "session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-1",
      blockReason:
        "OpenClaw exec host=node is active for this session. Codex app-server native execution cannot route shell, filesystem, MCP, or app-backed work through the selected OpenClaw node.",
    });
  });

  it("honors per-attempt node exec overrides before config defaults", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
        execOverrides: { host: "node", node: "worker-2" },
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-2",
    });
  });

  it("honors persisted session node exec hosts before config defaults", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: 1,
          execHost: "node",
          execNode: "worker-3",
        },
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-3",
    });
  });

  it("preserves a storage refusal instead of falling back to gateway execution", async () => {
    const refusal = new Error("The selected session is no longer current");
    sessionStoreMocks.captureSessionEntryCurrentCheck.mockImplementation(() => {
      throw refusal;
    });
    await expect(
      prepareCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "agent:main:dashboard:incognito-refused",
        readRuntimeSessionEntry: true,
      }),
    ).rejects.toThrow(refusal);
  });

  it("honors persisted default-session exec hosts with explicit main agent policy", async () => {
    mockSelectedEntry({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-5",
    });

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: { tools: { exec: { host: "gateway" } } },
          sessionKey: "main",
          agentId: "main",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-5",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "main",
        agentId: "main",
      }),
    );
  });

  it("honors persisted unscoped exec hosts for the configured default agent", async () => {
    mockSelectedEntry({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: {
            tools: { exec: { host: "gateway" } },
            agents: { entries: { "bot-a": {} } },
          },
          sessionKey: "node-session",
          agentId: "bot-a",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-6",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "node-session",
        agentId: "bot-a",
      }),
    );
  });

  it("does not read an unscoped session entry for an explicit multi-agent roster", async () => {
    mockSelectedEntry({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: {
            tools: { exec: { host: "gateway" } },
            agents: { entries: { alpha: {}, beta: {} } },
          },
          sessionKey: "node-session",
          agentId: "alpha",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheck).not.toHaveBeenCalled();
  });

  it("uses global policy when an explicit multi-agent roster has no selected agent", async () => {
    mockSelectedEntry({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      (
        await prepareCodexNativeExecutionPolicy({
          config: {
            tools: { exec: { host: "gateway" } },
            agents: { entries: { alpha: {}, beta: {} } },
          },
          sessionKey: "node-session",
          readRuntimeSessionEntry: true,
        })
      ).policy,
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
    expect(sessionStoreMocks.captureSessionEntryCurrentCheck).not.toHaveBeenCalled();
  });

  it("honors agent exec config before global exec config", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        sessionEntry: null,
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            entries: { main: { tools: { exec: { host: "node", node: "worker-4" } } } },
          },
        },
        sessionKey: "agent:main:session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-4",
    });
  });
});
