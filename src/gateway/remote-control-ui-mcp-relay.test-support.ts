import { EventEmitter } from "node:events";
import { expect } from "vitest";
import mcpRelayPlugin from "../../extensions/mcp-relay/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../plugin-sdk/plugin-test-api.js";
import {
  createPluginStateKeyedStore,
  type OpenAsyncKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import type {
  GatewayControlUiIngressFactoryV2,
  GatewayControlUiIngressOpenOptionsV2,
  GatewayControlUiIngressV2,
} from "../plugins/gateway-ingress.types.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import type { OpenClawPluginServiceContextV2, OpenClawPluginServiceV2 } from "../plugins/types.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  createPluginGatewayMethodDescriptor,
  type GatewayMethodDescriptor,
} from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connect,
  request,
  expectHello,
  usePeer as withIngressPeer,
  type Peer,
  type IngressFrame,
} from "./remote-control-ui-ingress.integration.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";

export const TRUSTED_PROXY = {
  userHeader: "cf-access-authenticated-user-email",
  requiredHeaders: ["cf-access-jwt-assertion"],
};
export const TEAM_ROLES: NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]> = {
  default: "reader",
  definitions: {
    admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
    reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
    policy: {
      scopes: ["operator.admin"],
      agents: "*",
      sessions: { others: "write" },
      accessPolicyPlugin: "unavailable-policy-fixture",
    },
  },
};

export type RelayFrame = {
  type: string;
  id?: string;
  sid?: string;
  op?: string;
  ok?: boolean;
  status?: number;
  b64?: string;
  text?: string;
  more?: boolean;
  code?: number | string;
  params?: { codeHash?: string; principal?: string; ceiling?: string[] };
  result?: unknown;
  error?: { code: string; message: string };
};

/** Only relay I/O is fake; the plugin, keyed state, and ingress transport are real. */
export class McpRelayTestSocket extends EventEmitter {
  static latest: McpRelayTestSocket | undefined;
  readonly #frames: RelayFrame[] = [];
  readonly #readers: Array<{
    matches: (frame: RelayFrame) => boolean;
    resolve: (frame: RelayFrame) => void;
  }> = [];
  bufferedAmount = 0;

  constructor() {
    super();
    McpRelayTestSocket.latest = this;
  }

  send(text: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(text) as RelayFrame;
    // The synthetic relay acknowledges durable revocation replays between service instances.
    if (frame.type === "req" && frame.op === "grant.revoke") {
      queueMicrotask(() => this.receive({ type: "res", id: frame.id, ok: true, result: {} }));
      callback?.();
      return;
    }
    const readerIndex = this.#readers.findIndex((reader) => reader.matches(frame));
    const reader = readerIndex < 0 ? undefined : this.#readers.splice(readerIndex, 1)[0];
    if (reader) {
      reader.resolve(frame);
    } else {
      this.#frames.push(frame);
    }
    callback?.();
  }

  receive(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  next(matches: (frame: RelayFrame) => boolean = () => true): Promise<RelayFrame> {
    const index = this.#frames.findIndex(matches);
    const frame = index < 0 ? undefined : this.#frames.splice(index, 1)[0];
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.#readers.push({ matches, resolve });
        });
  }

  close(code = 1000, reason = "") {
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close(1006);
  }
}

let grantSequence = 19;

export async function withMcpRelayIngress(
  params: {
    factory: GatewayControlUiIngressFactoryV2;
    config: OpenClawConfig;
    state: OpenClawTestState;
    context: GatewayRequestContext;
    publicOrigin: string;
    sandboxOrigin: string;
    frameAncestors: string[];
    caller: GatewayClient;
    isCallerCurrent: () => boolean;
    ceiling: string[];
    afterGrant?: () => Promise<void>;
  },
  usePeer: (peer: {
    send(frame: unknown): Promise<void>;
    read(): Promise<string>;
    dataRequest(op: string, params: Record<string, unknown>): Promise<RelayFrame>;
    revoke(): Promise<void>;
    readClosed(): Promise<RelayFrame>;
    openAgain(): Promise<RelayFrame>;
    errors: readonly string[];
  }) => Promise<void>,
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const runtime = createLazyPluginRuntime({});
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("mcp-relay", options, () => scheduler.signal.throwIfAborted());
  const methods: GatewayMethodDescriptor[] = [];
  const errors: string[] = [];
  let service: OpenClawPluginServiceV2 | undefined;
  const api = createTestPluginApi({
    config: params.config,
    runtime,
    logger: { info() {}, warn() {}, debug() {}, error: (message) => errors.push(message) },
    registerGatewayMethod: (name, handler, options) => {
      methods.push(
        createPluginGatewayMethodDescriptor({ pluginId: "mcp-relay", name, handler, ...options }),
      );
    },
    registerService: (registered) => {
      if (registered.apiVersion !== 2) {
        throw new Error("Expected the scheduler-owned MCP relay service");
      }
      service = registered;
    },
  });
  mcpRelayPlugin.register(api);
  if (!service) {
    throw new Error("MCP relay did not register its service");
  }
  const context: OpenClawPluginServiceContextV2 = {
    config: params.config,
    stateDir: params.state.stateDir,
    logger: api.logger,
    scheduler,
    controlUiIngress: params.factory,
  };
  const methodRegistry = createGatewayMethodRegistry(methods);
  const call = async (method: string, input: Record<string, unknown> = {}) =>
    dispatchGatewayRequestInProcess(`mcp-relay.${method}`, input, {
      client: params.caller,
      isWebchatConnect: () => false,
      context: params.context,
      signal: scheduler.signal,
      hasCurrentClientAuthority: params.isCallerCurrent,
      methodRegistry,
    });
  try {
    await service.start(context);
    await clock.advanceBy(0);
    const relay = McpRelayTestSocket.latest;
    if (!relay) {
      throw new Error("MCP relay did not connect");
    }
    const beforeReady = await call("status");
    const { gatewayId } = beforeReady as { gatewayId: string };
    relay.receive({
      type: "challenge",
      protocol: 1,
      nonce: Buffer.alloc(32, 7).toString("base64url"),
      relay: "mcp.openclaw.ai",
    });
    expect(await relay.next()).toMatchObject({ type: "hello", protocol: 1 });
    relay.receive({ type: "ready", gatewayId, ui: { frameAncestors: params.frameAncestors } });
    await clock.advanceBy(0);
    expect(await call("status")).toMatchObject({ ui: { available: true, basePath: "/claw" } });
    const pairing = call("pair", { ceiling: params.ceiling });
    void pairing.catch(() => {});
    const offer = await awaitGateBeforeSettlement(
      relay.next(),
      pairing,
      "Pairing completed without a relay offer",
    );
    expect(offer).toMatchObject({ type: "req", op: "pair.offer" });
    expect(offer.params).toMatchObject({
      principal: params.config.gateway?.roles ? "person" : "owner",
      ceiling: params.ceiling,
    });
    expect(offer.params).not.toHaveProperty("profileId");
    relay.receive({ type: "res", id: offer.id, ok: true, result: {} });
    await pairing;
    const grantId = `gr_${Buffer.alloc(32, ++grantSequence).toString("base64url")}`;
    relay.receive({
      type: "req",
      id: "grant-create",
      op: "grant.create",
      params: {
        grantId,
        codeHash: offer.params?.codeHash,
        client: { id: "integration", name: "Synthetic relay browser" },
      },
    });
    await clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({ type: "res", id: "grant-create", ok: true });
    await params.afterGrant?.();
    const origins = {
      grantId,
      publicOrigin: params.publicOrigin,
      sandboxOrigin: params.sandboxOrigin,
    };
    relay.receive({
      type: "ui.http",
      sid: "http-root",
      ...origins,
      surface: "control-ui",
      method: "GET",
      path: "/claw/",
      headers: [["accept", "text/html"]],
      b64: "",
      more: false,
    });
    const serving = clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({
      type: "ui.http.head",
      sid: "http-root",
      status: 200,
    });
    const chunks: Buffer[] = [];
    for (;;) {
      const frame = await relay.next();
      expect(frame).toMatchObject({
        type: "ui.http.body",
        sid: "http-root",
        b64: expect.any(String),
      });
      chunks.push(Buffer.from(frame.b64!, "base64"));
      if (!frame.more) {
        break;
      }
    }
    await serving;
    expect(Buffer.concat(chunks).toString()).toContain('data-openclaw-remote-ingress="true"');
    relay.receive({
      type: "ui.ws.open",
      sid: "ws-browser",
      ...origins,
      path: "/claw",
      origin: params.publicOrigin,
      protocols: [],
    });
    const opening = clock.advanceBy(0);
    expect(await relay.next()).toMatchObject({ type: "ui.ws.opened", sid: "ws-browser" });
    let requestSequence = 0;
    await usePeer({
      errors,
      send: async (frame) => {
        relay.receive({
          type: "ui.ws.msg",
          sid: "ws-browser",
          text: JSON.stringify(frame),
          more: false,
        });
        await clock.advanceBy(0);
      },
      read: async () => {
        const frame = await relay.next(
          (candidate) => candidate.type === "ui.ws.msg" && candidate.sid === "ws-browser",
        );
        expect(frame).toMatchObject({
          type: "ui.ws.msg",
          sid: "ws-browser",
          text: expect.any(String),
          more: false,
        });
        return frame.text!;
      },
      dataRequest: async (op, input) => {
        const id = `data-${++requestSequence}`;
        relay.receive({ type: "req", id, grantId, op, params: input });
        await clock.advanceBy(0);
        return relay.next((frame) => frame.type === "res" && frame.id === id);
      },
      revoke: async () => {
        relay.receive({
          type: "req",
          id: "revoke-grant",
          op: "grant.revoked",
          params: { grantId, reason: "client_revoked" },
        });
        await clock.advanceBy(0);
        expect(
          await relay.next((frame) => frame.type === "res" && frame.id === "revoke-grant"),
        ).toMatchObject({ ok: true });
      },
      readClosed: () =>
        relay.next(
          (frame) =>
            frame.sid === "ws-browser" &&
            (frame.type === "ui.error" || frame.type === "ui.ws.close"),
        ),
      openAgain: async () => {
        relay.receive({
          type: "ui.ws.open",
          sid: "ws-reopened",
          ...origins,
          path: "/claw",
          origin: params.publicOrigin,
          protocols: [],
        });
        await clock.advanceBy(0);
        return relay.next((frame) => frame.sid === "ws-reopened");
      },
    });
    relay.receive({ type: "ui.ws.close", sid: "ws-browser", code: 1000, reason: "proof complete" });
    await clock.advanceBy(0);
    await opening;
  } finally {
    await service.stop?.(context);
    await scheduler.stop();
    McpRelayTestSocket.latest = undefined;
  }
}

export async function expectMcpRelayPrincipalAuthority({
  factory,
  state,
  context,
  teamConfig,
  teamAuth,
  sharedToken,
  openOptions,
  ownerSessionKey,
  scopes,
  clients,
  openRemote,
  configure,
}: {
  factory: GatewayControlUiIngressFactoryV2;
  state: OpenClawTestState;
  context: GatewayRequestContext;
  teamConfig: OpenClawConfig;
  teamAuth: ResolvedGatewayAuth;
  sharedToken: string;
  openOptions: GatewayControlUiIngressOpenOptionsV2;
  ownerSessionKey: string;
  scopes: readonly string[];
  clients: GatewayClientRegistry;
  openRemote: (handle: GatewayControlUiIngressV2) => Promise<Peer>;
  configure: (config: OpenClawConfig, auth: ResolvedGatewayAuth) => Promise<void>;
}) {
  const admin = await ensureCanonicalUserProfileForEmail("admin@ingress.example.test");
  const restricted = await ensureCanonicalUserProfileForEmail("reader@ingress.example.test");
  for (const person of [admin, restricted]) {
    await setCanonicalUserProfileRole(person.id, "admin", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:ingress-${person.id}` },
      {
        sessionId: `ingress-${person.id}`,
        updatedAt: Date.now(),
        label: person.id,
        createdActor: { type: "human", source: "profile", id: person.id },
        visibility: "draft",
      },
    );
  }
  const scenarios = [
    { name: "owner-full", profileId: undefined, full: true, restricted: false },
    { name: "person-read-write", profileId: admin.id, full: false, restricted: false },
    { name: "person-full", profileId: admin.id, full: true, restricted: false },
    { name: "restricted-full", profileId: restricted.id, full: true, restricted: true },
  ];
  for (const scenario of scenarios) {
    const config: OpenClawConfig = scenario.profileId
      ? teamConfig
      : {
          ...teamConfig,
          gateway: {
            ...teamConfig.gateway,
            roles: undefined,
            auth: { mode: "token", token: sharedToken },
          },
        };
    const auth: ResolvedGatewayAuth = scenario.profileId
      ? teamAuth
      : { mode: "token", token: sharedToken, allowTailscale: false };
    await configure(config, auth);
    const approvingUi = await factory.open({
      ...openOptions,
      audienceId: `relay-consent-${scenario.name}`,
      principal: scenario.profileId
        ? { kind: "person", profileId: scenario.profileId }
        : { kind: "owner" },
      operatorScopeCeiling: ["operator.admin"],
    });
    try {
      await withIngressPeer(await openRemote(approvingUi), async (approvingPeer) => {
        const approvingIdentity = loadOrCreateDeviceIdentity({
          identityKey: `relay-consent-${scenario.name}`,
        });
        expectHello(
          await connect(approvingPeer, {
            identity: approvingIdentity,
            profileId: scenario.profileId,
          }),
          "remote-ingress",
          ["operator.admin"],
        );
        const caller = [...clients].find(
          (client) => client.connect.device?.id === approvingIdentity.deviceId,
        );
        if (!caller) {
          throw new Error("Missing admitted relay consent caller");
        }
        const ceiling = scenario.full ? ["operator.admin"] : [...scopes];
        await withMcpRelayIngress(
          {
            factory,
            config,
            state,
            context,
            publicOrigin: openOptions.publicOrigin,
            sandboxOrigin: openOptions.sandboxOrigin,
            frameAncestors: [...openOptions.frameAncestors],
            caller,
            isCallerCurrent: () => clients.has(caller),
            ceiling,
            ...(scenario.restricted
              ? {
                  afterGrant: async () => {
                    await setCanonicalUserProfileRole(restricted.id, "reader", {
                      onCommitted: invalidateOperatorRolePolicy,
                    });
                  },
                }
              : {}),
          },
          async (relayPeer) => {
            const peer: Peer = {
              send: (frame) => relayPeer.send(frame),
              read: async () => JSON.parse(await relayPeer.read()) as IngressFrame,
              close: async () => {},
            };
            const effectiveScopes = scenario.restricted ? ["operator.read"] : ceiling;
            const hello = await connect(peer, {
              identity: loadOrCreateDeviceIdentity({
                identityKey: `synthetic-mcp-relay-${scenario.name}`,
              }),
              scopes: [],
              profileId: scenario.profileId,
            });
            expectHello(hello, "remote-ingress", effectiveScopes);
            expect(hello.payload?.controlUiUrl).toBe(`${openOptions.publicOrigin}/claw`);
            expect(await request(peer, "users.self", {})).toMatchObject({
              ok: true,
              payload: { profile: { id: scenario.profileId ?? "gateway-owner" } },
            });
            expect(await request(peer, "exec.approvals.get", {})).toMatchObject({
              ok: scenario.full && !scenario.restricted,
            });
            expect(
              await request(peer, "voicewake.set", { triggers: [scenario.name] }),
            ).toMatchObject({
              ok: !scenario.restricted,
            });
            expect(await relayPeer.dataRequest("status", {})).toMatchObject({
              ok: true,
              result: { agents: [expect.objectContaining({ id: "main" })] },
            });
            const ownKey = scenario.profileId
              ? `agent:main:ingress-${scenario.profileId}`
              : ownerSessionKey;
            const listed = await relayPeer.dataRequest("conversations.list", { limit: 50 });
            expect(listed).toMatchObject({
              ok: true,
              result: {
                conversations: expect.arrayContaining([
                  expect.objectContaining({ conversationId: ownKey }),
                ]),
              },
            });
            const history = await relayPeer.dataRequest("conversation.read", {
              conversationId: ownKey,
              limit: 1,
            });
            expect(
              history,
              JSON.stringify({ scenario: scenario.name, history, errors: relayPeer.errors }),
            ).toMatchObject({
              ok: true,
              result: { conversationId: ownKey, messages: [] },
            });
            if (scenario.restricted) {
              const foreignKey = `agent:main:ingress-${admin.id}`;
              expect(listed).toMatchObject({
                result: {
                  conversations: expect.not.arrayContaining([
                    expect.objectContaining({ conversationId: foreignKey }),
                  ]),
                },
              });
              expect(
                await relayPeer.dataRequest("conversation.read", {
                  conversationId: foreignKey,
                  limit: 1,
                }),
              ).toMatchObject({
                ok: false,
                error: { code: "not_found" },
              });
              expect(
                await relayPeer.dataRequest("message.send", {
                  conversationId: ownKey,
                  message: "Must not start",
                  waitMs: 0,
                }),
              ).toMatchObject({ ok: false });
              expect(relayPeer.errors).toContainEqual(
                expect.stringContaining(
                  "method=chat.send FORBIDDEN: missing scope: operator.write",
                ),
              );
            }
            const downgradeLiveGrant = scenario.name === "person-full";
            if (downgradeLiveGrant) {
              await setCanonicalUserProfileRole(admin.id, "reader", {
                onCommitted: invalidateOperatorRolePolicy,
              });
              expect(await relayPeer.dataRequest("status", {})).toMatchObject({ ok: false });
              expect(await relayPeer.readClosed()).toMatchObject({ sid: "ws-browser" });
              expect(await relayPeer.dataRequest("status", {})).toMatchObject({
                ok: true,
                result: { agents: [expect.objectContaining({ id: "main" })] },
              });
              expect(
                await relayPeer.dataRequest("message.send", {
                  conversationId: ownKey,
                  message: "Must not start after downgrade",
                  waitMs: 0,
                }),
              ).toMatchObject({ ok: false });
              expect(relayPeer.errors).toContainEqual(
                expect.stringContaining(
                  "method=chat.send FORBIDDEN: missing scope: operator.write",
                ),
              );
            }
            await relayPeer.revoke();
            if (!downgradeLiveGrant) {
              expect(await relayPeer.readClosed()).toMatchObject({
                type: "ui.error",
                code: "grant_revoked",
              });
            }
            expect(await relayPeer.dataRequest("conversations.list", { limit: 1 })).toMatchObject({
              ok: false,
              error: { code: "grant_revoked" },
            });
            expect(await relayPeer.openAgain()).toMatchObject({
              type: "ui.error",
              code: "grant_revoked",
            });
          },
        );
      });
    } finally {
      await approvingUi.close();
    }
  }
}
