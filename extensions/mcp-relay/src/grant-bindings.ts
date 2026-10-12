import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV1,
  type GatewayControlUiIngressFactoryV2,
  type GatewayIngressPrincipalBindingV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import { RelayError } from "./protocol.js";
import type { RelayState } from "./state.js";

export function principalFactory(
  factory: GatewayControlUiIngressFactoryV1 | GatewayControlUiIngressFactoryV2 | undefined,
): GatewayControlUiIngressFactoryV2 {
  if (!factory || !("capabilityVersion" in factory) || factory.capabilityVersion !== 2) {
    throw new RelayError(
      "unavailable",
      "Update OpenClaw to enable principal-bound MCP and Control UI access.",
    );
  }
  return factory;
}

type Binding = { abort: AbortController; pending: Promise<GatewayIngressPrincipalBindingV1> };

/** The relay connection owns one principal resolution shared by each grant's UI and RPC. */
export class GrantBindings {
  readonly #bindings = new Map<string, Binding>();
  readonly #closing = new Set<Promise<void>>();
  constructor(
    readonly factory: GatewayControlUiIngressFactoryV2,
    readonly state: Pick<RelayState, "getGrant" | "assertGrantCurrent">,
    readonly signal: AbortSignal,
  ) {}

  async get(grantId: string): Promise<GatewayIngressPrincipalBindingV1> {
    this.signal.throwIfAborted();
    this.state.assertGrantCurrent(grantId);
    const existing = this.#bindings.get(grantId);
    if (existing) {
      return existing.pending;
    }
    if (this.#bindings.size + this.#closing.size >= 32) {
      throw new RelayError(
        "unavailable",
        "Too many active connected apps. Reconnect the relay and try again.",
      );
    }
    const grant = this.state.getGrant(grantId);
    if (!grant) {
      throw new RelayError(
        "grant_revoked",
        "This app was disconnected. Connect it again from Connected apps.",
      );
    }
    const abort = new AbortController();
    const pending = this.factory.bindPrincipal({
      audienceId: grantId,
      principal: grant.principal,
      operatorScopeCeiling: grant.ceiling,
      signal: AbortSignal.any([this.signal, abort.signal]),
      assertCurrent: () => {
        this.signal.throwIfAborted();
        abort.signal.throwIfAborted();
        this.state.assertGrantCurrent(grantId);
      },
    });
    const binding = { abort, pending };
    this.#bindings.set(grantId, binding);
    try {
      return await pending;
    } catch (error) {
      this.revoke(grantId);
      throw error;
    }
  }

  retireOnFailure(grantId: string, error: unknown): void {
    if (
      error instanceof GatewayControlUiIngressError &&
      ["closed", "forbidden", "unsupported-auth"].includes(error.code)
    ) {
      this.revoke(grantId);
    }
  }

  revoke(grantId: string): void {
    const binding = this.#bindings.get(grantId);
    if (!binding) {
      return;
    }
    this.#bindings.delete(grantId);
    binding.abort.abort();
    const closing = binding.pending.then(
      (handle) => handle.close(),
      () => undefined,
    );
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing)).catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const id of this.#bindings.keys()) {
      this.revoke(id);
    }
    await Promise.all(this.#closing);
  }
}
