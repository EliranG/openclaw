// Preserve the cancellation fixture setup before importing its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it } from "vitest";
import {
  createReplyOperation,
  isReplyRunAbortableForSignal,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";

useChatAbortRegistryFixture();

it("publishes deletion cancellation before aborting the reply operation", async () => {
  const sessionKey = "agent:main:delete-before-execution";
  const sessionId = "delete-before-execution-session";
  const runId = "delete-before-execution-run";
  await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
  const context = createDirectChatContext({ getRuntimeConfig });
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId,
    sessionKey,
    agentId: "main",
    timeoutMs: 30_000,
    isAbortable: (entry) => isReplyRunAbortableForSignal(entry.controller.signal),
  });
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    agentId: "main",
    resetTriggered: false,
    upstreamAbortSignal: registration.controller.signal,
  });
  const terminals: unknown[] = [];
  const unsubscribe = onAgentRuntimeEvent((event) => {
    if (event.runId === runId && event.stream === "lifecycle") {
      terminals.push(event.data);
    }
  });
  try {
    await abortChatRunsForSessionKeyWithPartials({
      context,
      ops: createChatAbortOps(context),
      sessionKey,
      sessionId,
      agentId: "main",
      defaultAgentId: "main",
      stopReason: "delete",
      abortOrigin: "rpc",
      requester: { isAdmin: true },
      onAuthorizedBeforeEmbeddedAbort: () => operation.abortByUser(),
    });
    expect(registration.controller.signal.aborted).toBe(true);
    expect(registration.entry?.abortStopReason).toBe("delete");
    expect(operation.result?.kind).toBe("aborted");
    expect(terminals).toContainEqual(
      expect.objectContaining({ phase: "end", aborted: true, stopReason: "delete" }),
    );
  } finally {
    unsubscribe();
    operation.complete();
    registration.cleanup();
  }
});
