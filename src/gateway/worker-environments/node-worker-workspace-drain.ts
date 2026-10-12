import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import {
  createNodeRunnerInventoryIssueError,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
} from "../../infra/node-runner-inventory.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { RETRYABLE_NODE_WORKER_TRANSPORT_CODES } from "./node-launch-adapter.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { NodeWorkerWorkspaceBinding } from "./node-worker-workspace-actions.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

type NodeWorkerWorkspaceDrainRequest = {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  deviceFolder?: string;
  timeoutMs: number;
  findNode: (signal: AbortSignal) => Promise<{
    transport: NodeWorkerSupervisorTransport;
    node: NodeWorkerSupervisorNodeProof;
  }>;
  isAuthorized: () => boolean;
};

/** Cancellation is only a request. This acknowledgement joins the node's physical workspace queue. */
export async function drainNodeWorkerWorkspace(
  params: NodeWorkerWorkspaceDrainRequest,
): Promise<void> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  const { transport, node } = await params.findNode(signal);
  const result = await transport.invoke({
    node,
    command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
    params: {
      gatewayNamespace: params.gatewayNamespace,
      environmentId: params.environmentId,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      ...(params.deviceFolder === undefined ? {} : { deviceFolder: params.deviceFolder }),
      argv: [NODE_WORKSPACE_DRAIN_COMMAND],
    },
    timeoutMs: params.timeoutMs,
    signal,
    isDispatchAuthorized: params.isAuthorized,
  });
  if (!result.ok) {
    throw new WorkerTunnelOwnerDisconnectedError(
      `Node workspace operations have not drained (${result.error?.code ?? "UNAVAILABLE"}); reconnect the session runner before retrying`,
    );
  }
  if (!params.isAuthorized()) {
    throw new Error("Node workspace drain authority closed");
  }
  const parsed = parseNodeWorkerWorkspaceExecResult(JSON.parse(result.payloadJSON ?? "null"));
  if (parsed?.termination !== "exit" || parsed.code !== 0 || parsed.stdout.trim() !== "drained") {
    throw new Error("Node workspace drain acknowledgement is invalid");
  }
}

/** Retirement authorizes stopping only the exact old environment, never its replacement. */
export async function stopNodeWorkerWorkspaceEnvironment(
  params: NodeWorkerWorkspaceDrainRequest,
): Promise<void> {
  const signal = AbortSignal.timeout(params.timeoutMs);
  const { transport, node } = await params.findNode(signal);
  if (node.workerHost.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION) {
    throw createNodeRunnerInventoryIssueError(node.nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE);
  }
  const result = await raceNodeWorkerOperation(
    transport.invoke({
      node,
      command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
      params: {
        gatewayNamespace: params.gatewayNamespace,
        environmentId: params.environmentId,
        sessionId: params.sessionId,
        ownerEpoch: params.ownerEpoch,
      },
      timeoutMs: params.timeoutMs,
      signal,
      isDispatchAuthorized: params.isAuthorized,
    }),
    signal,
  );
  if (!result.ok) {
    const code = result.error?.code ?? "UNAVAILABLE";
    const message = `node worker environment stop failed (${code})`;
    throw RETRYABLE_NODE_WORKER_TRANSPORT_CODES.has(code)
      ? new WorkerTunnelOwnerDisconnectedError(message)
      : new Error(message);
  }
}

/** A restarted Gateway recovers cleanup scope from the durable attachment, not bundle metadata. */
export async function restoreNodeWorkerWorkspaceDrainOwner(
  record: WorkerEnvironmentRecord,
  resolveBinding?: (binding: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
  }) => Promise<NodeWorkerWorkspaceBinding | undefined>,
) {
  if (record.attachedSessionIds.length > 1) {
    throw new Error("node worker environment teardown has an ambiguous session owner");
  }
  const sessionId = record.attachedSessionIds[0];
  if (!sessionId || !record.nodeDeviceId) {
    return undefined;
  }
  const binding = await resolveBinding?.({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId,
  });
  if (binding?.source.kind === "device-folder" && binding.source.deviceId !== record.nodeDeviceId) {
    throw new Error("Device folder does not belong to this workspace runner");
  }
  return {
    deviceId: record.nodeDeviceId,
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId,
    ...(binding?.source.kind === "device-folder"
      ? { deviceFolder: binding.remoteWorkspaceDir }
      : {}),
    executionMode:
      record.profileSnapshot.executionMode === "remote-exec"
        ? ("remote-exec" as const)
        : ("worker-turn" as const),
  };
}
