// Preserve the cancellation fixture setup before importing its consumers.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createReplyOperation,
  isReplyRunAbortableForSignal,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

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
  const subscriptions = startGatewayEventSubscriptions({
    scheduler: createTestGatewayScheduler(),
    signal: new AbortController().signal,
    log: context.logGateway,
    broadcast: context.broadcast,
    broadcastToConnIds: context.broadcastToConnIds,
    nodeHasSessionSubscribers: () => false,
    nodeSendToSession: context.nodeSendToSession,
    agentRunSeq: context.agentRunSeq,
    chatRunState: context.chatRunState,
    toolEventRecipients: context.chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    chatAbortControllers: context.chatAbortControllers,
    restartRecoveryCandidates: new Map(),
    refreshConnectedUserProfiles: vi.fn(),
  });
  const aborted = createDeferred();
  operation.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
  let draining: ReturnType<typeof prepareSessionLifecycleDrain> | undefined;
  const terminals: unknown[] = [];
  const unsubscribe = onAgentRuntimeEvent((event) => {
    if (event.runId === runId && event.stream === "lifecycle") {
      terminals.push(event.data);
    }
  });
  try {
    draining = prepareSessionLifecycleDrain({
      action: "delete",
      context,
      storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: "main",
      }),
      sessionKeys: [sessionKey],
      sessionKey,
      sessionId,
      agentId: "main",
      defaultAgentId: "main",
      lifecycleIdentities: [sessionKey, sessionId],
    });
    void draining.catch(() => {});
    await aborted.promise;
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
    const drain = await draining;
    drain?.release();
    await subscriptions.agentUnsub();
    subscriptions.heartbeatUnsub();
    subscriptions.transcriptUnsub();
    subscriptions.lifecycleUnsub();
  }
});
