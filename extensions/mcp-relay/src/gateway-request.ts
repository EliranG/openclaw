import type { GatewayIngressPrincipalBindingV1 } from "openclaw/plugin-sdk/gateway-ingress";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RelayError } from "./protocol.js";

export type GatewayRequest = (
  ...args: Parameters<GatewayIngressPrincipalBindingV1["request"]>
) => Promise<unknown>;

export type DeadlineGatewayRequest = (
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<unknown>;

function deadlineError() {
  return new RelayError(
    "timeout",
    "This request reached its time limit. Check the conversation in OpenClaw before retrying.",
  );
}

export function createDeadlineGatewayRequest(
  request: GatewayRequest,
  deadline: number,
  now: () => number,
): DeadlineGatewayRequest {
  return async (method, params, options) => {
    const startedAt = now();
    const remaining = Math.floor(deadline - startedAt);
    if (remaining <= 0) {
      throw deadlineError();
    }
    const timeoutMs = Math.min(options?.timeoutMs ?? remaining, remaining);
    const rpcDeadline = startedAt + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(deadlineError()), timeoutMs);
    timer.unref();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    // Let agent.wait publish its observation before the surrounding RPC timer wins.
    const boundedParams =
      method === "agent.wait" && typeof params?.timeoutMs === "number"
        ? { ...params, timeoutMs: Math.min(params.timeoutMs, Math.max(0, timeoutMs - 1_000)) }
        : params;
    try {
      return await request(method, boundedParams, { signal });
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      const code = isRecord(error) ? error.code : undefined;
      if (
        controller.signal.aborted ||
        code === "CLIENT_TIMEOUT" ||
        code === "AGENT_TIMEOUT" ||
        (code === undefined && error instanceof Error && now() >= rpcDeadline)
      ) {
        throw deadlineError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
