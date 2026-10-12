import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { captureExecRequestSubagentSelection } from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import { prepareSessionCapabilityRead } from "../../agents/subagents/spawn/subagent-session-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  sessionId?: string;
  execCancellation?: ReturnType<typeof captureExecRequestCancellation>;
  sessionOrigin?: SubagentRequestSessionOrigin;
  assertCurrent?: () => void;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
  prepareSelection?: {
    acceptsRequest: SubagentRequestSessionOrigin["acceptsRequest"];
    prepare: () => Promise<{
      execCancellation: ReturnType<typeof captureExecRequestCancellation>;
      sessionOrigin?: SubagentRequestSessionOrigin;
    }>;
  };
}) {
  const preparedController = await prepareSessionCapabilityRead(() =>
    resolveSubagentController({
      cfg: params.cfg,
      agentSessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
  );
  using controllerRead = { [Symbol.dispose]: preparedController.release };
  void controllerRead;
  params.assertCurrent?.();
  const controller = preparedController.read();
  const assertCurrent = () => {
    params.assertCurrent?.();
    preparedController.read();
  };
  let commands =
    params.execCancellation ??
    captureExecRequestCancellation({
      runId: params.requesterTurnRunId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  let selected = captureExecRequestSubagentSelection({
    ...params,
    controller,
    owners: commands.owners,
    candidateOrigin: params.prepareSelection
      ? {
          target: {
            sessionKey: controller.controllerSessionKey,
            agentId: controller.controllerAgentId,
          },
          acceptsRequest: params.prepareSelection.acceptsRequest,
        }
      : undefined,
  });
  const preparation = params.prepareSelection;
  const prepare = preparation
    ? async () => {
        const prepared = await preparation.prepare();
        commands = prepared.execCancellation;
        selected = captureExecRequestSubagentSelection({
          ...params,
          controller,
          owners: commands.owners,
          sessionOrigin: prepared.sessionOrigin,
        });
      }
    : undefined;
  const requestSelection = {
    runs: selected.runs,
    ownsRoot: (entry: (typeof selected.runs)[number]) => selected.ownsRoot(entry),
    selectPublishedRoot:
      preparation || selected.selectPublishedRoot
        ? (entry: (typeof selected.runs)[number]) => selected.selectPublishedRoot?.(entry) === true
        : undefined,
    get sessionGeneration() {
      return selected.sessionGeneration;
    },
    prepare,
  };
  let execAborted = false;
  const commandErrors: unknown[] = [];
  const beforeKill = async (sealRootSelection = () => {}) => {
    // Gateway callbacks signal their captured parent before awaiting its cleanup.
    sealRootSelection();
    if ((await params.beforeKill?.(sealRootSelection)) === false) {
      return false;
    }
    try {
      assertCurrent();
    } catch (error) {
      // Without descendants, the caller owns the original authority exception.
      if (requestSelection.runs.length === 0) {
        throw error;
      }
      commandErrors.push(error);
      return false;
    }
    execAborted = commands.cancel();
    return true;
  };
  let descendants: Awaited<ReturnType<typeof killAllControlledSubagentRuns>> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (requestSelection.runs.length === 0 && !prepare) {
      await beforeKill();
    } else {
      descendants = await killAllControlledSubagentRuns({
        cfg: params.cfg,
        controller,
        runs: requestSelection.runs,
        requestSelection,
        suppressTaskDelivery: true,
        assertCurrent,
        beforeKill,
      });
    }
  } catch (error) {
    failure = { error };
  }
  try {
    // The parent may already have accepted Stop before the caller was revoked.
    await commands.settle();
  } catch (error) {
    commandErrors.push(error);
  }
  if (failure) {
    throw commandErrors.length > 0
      ? new AggregateError([failure.error, ...commandErrors], "Request cancellation was incomplete")
      : failure.error;
  }
  if (commandErrors.length > 0) {
    return {
      ...(descendants ?? { killed: 0, labels: [] }),
      status: "error" as const,
      error: [
        ...(descendants && descendants.status !== "ok" ? [descendants.error] : []),
        ...commandErrors.map(formatErrorMessage),
      ].join("; "),
      execAborted: execAborted || descendants?.execAborted === true,
    };
  }
  return descendants || execAborted
    ? {
        ...(descendants ?? { status: "ok" as const, killed: 0, labels: [] }),
        execAborted: execAborted || descendants?.execAborted === true,
      }
    : undefined;
}

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>>,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}
