import { captureSessionWorkRunInterruptions } from "../../../sessions/session-lifecycle-admission.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import type { captureSubagentCommands } from "./subagent-control-commands.js";
import type { createSubagentKillAcceptance } from "./subagent-control-kill-acceptance.js";
import type { SubagentKillSession } from "./subagent-control-session.js";
import {
  type captureSubagentEmbeddedExecution,
  captureSubagentExecution,
  type captureSubagentReplyExecution,
} from "./subagent-registry-execution-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function interruptLegacySubagentRun(params: {
  entry: SubagentRunRecord;
  session: SubagentKillSession;
  embeddedExecution: ReturnType<typeof captureSubagentEmbeddedExecution>;
  replyExecution: Awaited<ReturnType<typeof captureSubagentReplyExecution>>;
  captureExecution: () => ReturnType<typeof captureSubagentExecution>;
  commands: ReturnType<typeof captureSubagentCommands>;
  acceptance: ReturnType<typeof createSubagentKillAcceptance>;
  stopAcceptance: { accepted: boolean };
  assertCallerCurrent: () => void;
  assertSelectedRun: () => void;
}): Promise<"ready" | "busy" | "superseded"> {
  const { entry, session, embeddedExecution, replyExecution, acceptance, stopAcceptance } = params;
  const reason = createAgentRunDirectAbortError();
  const ownedAdmissions = captureSessionWorkRunInterruptions({
    scope: session.storePath,
    identities: [entry.childSessionKey, embeddedExecution?.sessionId, replyExecution?.sessionId],
    accept: (run) =>
      run.runId === entry.runId &&
      run.sessionKey === entry.childSessionKey &&
      run.agentId === session.agentId &&
      (!entry.childSessionIdentity?.sessionId ||
        run.sessionId === entry.childSessionIdentity.sessionId),
  });
  const captured = params.captureExecution();
  if (captured) {
    if (captureSubagentExecution({ entry, session })?.execution !== captured.execution) {
      return "superseded";
    }
    captured.execution.controller.abort(reason);
    acceptance.accept(true);
  } else if (embeddedExecution) {
    acceptance.accept(embeddedExecution.abort());
  } else if (replyExecution) {
    acceptance.accept(replyExecution.abort());
  }
  if (!stopAcceptance.accepted && params.commands) {
    acceptance.accept(
      params.commands.cancel(() => {
        params.assertCallerCurrent();
        params.assertSelectedRun();
      }),
    );
  }
  const interrupted = ownedAdmissions.map((owned) => owned.released);
  if (replyExecution?.settlement && stopAcceptance.accepted) {
    interrupted.push(replyExecution.settlement);
  }
  for (const owned of ownedAdmissions) {
    if (acceptance.callerFailure) {
      break;
    }
    params.assertCallerCurrent();
    params.assertSelectedRun();
    acceptance.accept(owned.interrupt(reason));
  }
  return interrupted.length === 0 ||
    (await acceptance.drain(
      Promise.all(interrupted).then(() => {}),
      () => stopAcceptance.accepted,
    ))
    ? "ready"
    : "busy";
}
