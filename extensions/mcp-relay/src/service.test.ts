import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeHash } from "./protocol.js";
import type { RelayGrantAuthority } from "./state.js";
import {
  CHALLENGE,
  CLIENT,
  createPrincipalIngress,
  createTransportFixture,
  GATEWAY_ID,
  PUBLIC_KEY,
  SIGNATURE,
} from "./transport.test-helpers.js";
import { abortable, HTTP, IngressSocket, ORIGINS, WS } from "./ui-tunnel.test-helpers.js";

const unavailableUi = {
  available: false,
  reason: "Update the MCP relay to support the Control UI tunnel, then reconnect.",
};
const uiCapability = { frameAncestors: ["https://chatgpt.com"] };
const PERSON_AUTHORITY: RelayGrantAuthority = {
  principal: { kind: "person", profileId: "private-person-profile" },
  principalLabel: "Synthetic person",
  ceiling: ["operator.read", "operator.write"],
};
const REQUEST_ID = "A".repeat(43);
const REQUEST_DETAILS = {
  kind: "oauth",
  clientName: CLIENT.name,
  redirectHost: "chatgpt.com",
  expiresAt: 601_000,
};

const fixtures: Awaited<ReturnType<typeof createTransportFixture>>[] = [];
async function fixture(...args: Parameters<typeof createTransportFixture>) {
  const value = await createTransportFixture(...args);
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.stop()));
});

function denied(id: string, code: string) {
  return { type: "res", id, ok: false, error: { code, message: expect.any(String) } };
}

async function createGrant(f: Awaited<ReturnType<typeof fixture>>, grantId = "gr_one") {
  const hash = codeHash(grantId);
  await f.state.issue(hash, f.scheduler.now() + 600_000, f.scheduler.now());
  await f.state.createGrant({ grantId, codeHash: hash, client: CLIENT }, f.scheduler.now());
}

describe("MCP relay transport and authority", () => {
  it.each(["missing", "legacy"])(
    "refuses delegated operations on a %s principal-capability host",
    async (host) => {
      const operations = vi.fn(async () => ({}));
      const f = await fixture(operations, {
        controlUiIngress:
          host === "missing"
            ? undefined
            : {
                open: async () => {
                  throw new Error("A legacy ingress must not be used");
                },
              },
      });
      await createGrant(f);
      await f.ready(f.socket, uiCapability);
      expect((await f.service.status()).ui).toMatchObject({
        available: false,
        reason: expect.stringContaining("Update OpenClaw"),
      });
      expect(
        await f.request({ id: "legacy-read", op: "status", params: {}, grantId: "gr_one" }),
      ).toEqual(denied("legacy-read", "unavailable"));
      expect(operations).not.toHaveBeenCalled();
      await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
    },
  );

  it("signs the relay challenge, becomes ready, and sends text pings every 30 seconds", async () => {
    const f = await fixture();
    expect(f.addresses).toEqual([`wss://mcp.openclaw.ai/v1/gateway/connect?key=${PUBLIC_KEY}`]);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
    expect(await f.ready()).toEqual({
      type: "hello",
      protocol: 1,
      signature: SIGNATURE,
      gateway: { name: "Synthetic Gateway", version: "2026.10.9" },
    });
    await expect(f.service.status()).resolves.toEqual({
      connected: true,
      gatewayId: GATEWAY_ID,
      relayUrl: "https://mcp.openclaw.ai",
      grantsCount: 0,
      ui: unavailableUi,
    });
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(29_999);
    expect(f.socket.frames).toHaveLength(1);
    await f.clock.advanceBy(1);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    f.socket.receive({ type: "pong" });
    await f.clock.advanceBy(30_000);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    expect(f.socket.closes).toEqual([]);
  });

  it.each([
    { name: "wrong protocol", frame: { ...CHALLENGE, protocol: 2 }, helloFirst: false },
    { name: "wrong relay", frame: { ...CHALLENGE, relay: "other.example" }, helloFirst: false },
    { name: "short nonce", frame: { ...CHALLENGE, nonce: "AQ" }, helloFirst: false },
    {
      name: "noncanonical nonce",
      frame: { ...CHALLENGE, nonce: `${CHALLENGE.nonce.slice(0, -1)}d` },
      helloFirst: false,
    },
    { name: "premature ready", frame: { type: "ready", gatewayId: GATEWAY_ID }, helloFirst: false },
    { name: "wrong identity", frame: { type: "ready", gatewayId: "gw_other" }, helloFirst: true },
  ])("rejects a $name handshake", async ({ frame, helloFirst }) => {
    const f = await fixture();
    if (helloFirst) {
      f.socket.receive(CHALLENGE);
      await f.socket.nextFrame();
    }
    f.socket.receive(frame);
    expect(f.socket.closes).toEqual([{ code: 4400, reason: "Invalid handshake" }]);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
  });

  it("times out an incomplete handshake and backs off a replacement connection", async () => {
    const f = await fixture();
    await f.clock.advanceBy(9_999);
    expect(f.socket.closes).toEqual([]);
    await f.clock.advanceBy(1);
    expect(f.socket.closes).toEqual([{ code: 4400, reason: "Handshake timed out" }]);
    expect(f.socket.terminated).toBe(true);
    await f.clock.advanceBy(0);
    expect(f.clock.armedAtMs).toBe(12_000);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it.each([
    { code: 4401, delays: [60_000, 60_000] },
    { code: 4409, delays: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000] },
  ])("retries close $code with bounded backoff", async ({ code, delays }) => {
    const f = await fixture();
    for (const delay of delays) {
      const socket = f.sockets.at(-1);
      if (!socket) {
        throw new Error("Expected an active socket");
      }
      socket.close(code);
      await f.clock.advanceBy(0);
      const previousCount = f.sockets.length;
      expect(f.clock.armedAtMs).toBe(f.scheduler.now() + delay);
      await f.clock.advanceBy(delay - 1);
      expect(f.sockets).toHaveLength(previousCount);
      await f.clock.advanceBy(1);
      expect(f.sockets).toHaveLength(previousCount + 1);
    }
    await f.ready(f.sockets.at(-1));
    await f.clock.advanceBy(0);
    f.sockets.at(-1)?.close(4409);
    await f.clock.advanceBy(0);
    expect(f.clock.armedAtMs).toBe(f.scheduler.now() + 1_000);
  });

  it.each(["connected", "reconnecting"])("stops all scheduled work while %s", async (phase) => {
    const f = await fixture();
    await f.ready();
    await f.clock.advanceBy(0);
    if (phase === "reconnecting") {
      f.socket.close(4409);
      await f.clock.advanceBy(0);
    }
    await f.service.stop();
    if (phase === "connected") {
      expect(f.socket.terminated).toBe(true);
    }
    expect(f.clock.armedAtMs).toBeNull();
    await f.clock.advanceBy(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.socket.frames).toHaveLength(1);
    await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each(["owner", "person"] as const)(
    "persists only the code hash and keeps %s profile IDs out of pairing offers",
    async (principal) => {
      const f = await fixture();
      await expect(f.service.pair()).rejects.toMatchObject({ code: "unavailable" });
      await f.ready();
      await f.clock.advanceBy(0);
      const pairing = f.service.pair(
        undefined,
        principal === "person" ? PERSON_AUTHORITY : undefined,
      );
      const offer = await f.socket.nextFrame();
      expect(offer).toEqual({
        type: "req",
        id: expect.any(String),
        op: "pair.offer",
        params: {
          codeHash: expect.any(String),
          expiresAt: 601_000,
          principal,
          ceiling: ["operator.read", "operator.write"],
          ...(principal === "person" ? { principalLabel: "Synthetic person" } : {}),
        },
      });
      const persisted = f.storage.persisted();
      expect(persisted).toContain('"consumed":false');
      f.socket.acknowledge(offer);
      const paired = await pairing;
      expect(paired).toEqual({
        code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/),
        expiresAt: 601_000,
        mcpUrl: "https://mcp.openclaw.ai/mcp",
      });
      expect(offer.params).toEqual({
        codeHash: codeHash(paired.code),
        expiresAt: paired.expiresAt,
        principal,
        ceiling: ["operator.read", "operator.write"],
        ...(principal === "person" ? { principalLabel: "Synthetic person" } : {}),
      });
      expect(persisted).toContain(codeHash(paired.code));
      expect(persisted).not.toContain(paired.code);
      expect(JSON.stringify(f.socket.frames)).not.toContain("private-person-profile");
    },
  );

  it("records Gateway consent before approving OAuth without disclosing the person's profile ID", async () => {
    const f = await fixture();
    await f.ready();
    await f.clock.advanceBy(0);
    const approving = f.service.consent.approve(REQUEST_ID, PERSON_AUTHORITY, () => {});
    const description = await f.socket.nextFrame();
    expect(description).toMatchObject({
      op: "authorize.describe",
      params: { requestId: REQUEST_ID },
    });
    f.socket.acknowledge(description, { ...REQUEST_DETAILS, profileId: "relay-selected-profile" });
    const approval = await f.socket.nextFrame();
    expect(approval).toEqual({
      type: "req",
      id: expect.any(String),
      op: "authorize.approve",
      params: {
        requestId: REQUEST_ID,
        grantId: expect.stringMatching(/^gr_[A-Za-z0-9_-]{43}$/),
        principal: "person",
        principalLabel: "Synthetic person",
        ceiling: ["operator.read", "operator.write"],
      },
    });
    if (!isRecord(approval.params) || typeof approval.params.grantId !== "string") {
      throw new Error("Expected an approval grant ID");
    }
    expect(f.state.getGrant(approval.params.grantId)).toMatchObject({
      ...PERSON_AUTHORITY,
      clientName: CLIENT.name,
      createdAt: 1_000,
    });
    expect(JSON.stringify(f.socket.frames)).not.toContain("profileId");
    expect(JSON.stringify(f.socket.frames)).not.toContain("private-person-profile");
    f.socket.acknowledge(approval);
    await expect(approving).resolves.toEqual({
      continueUrl: `https://mcp.openclaw.ai/oauth/continue?request=${REQUEST_ID}`,
    });
  });

  it("denies a link request and returns the relay continuation without creating a grant", async () => {
    const f = await fixture();
    await f.ready();
    const denying = f.service.consent.deny(REQUEST_ID, () => {});
    const description = await f.socket.nextFrame();
    f.socket.acknowledge(description, { ...REQUEST_DETAILS, kind: "link" });
    const denial = await f.socket.nextFrame();
    expect(denial).toMatchObject({ op: "authorize.deny", params: { requestId: REQUEST_ID } });
    f.socket.acknowledge(denial);
    await expect(denying).resolves.toEqual({
      continueUrl: `https://mcp.openclaw.ai/oauth/continue?request=${REQUEST_ID}`,
    });
    await expect(f.state.grants()).resolves.toEqual([]);
  });

  it.each(["expired", "foreign", "missing kind"])(
    "refuses an %s consent request before persisting or approving a grant",
    async (reason) => {
      const f = await fixture();
      await f.ready();
      const approving = f.service.consent.approve(REQUEST_ID, PERSON_AUTHORITY, () => {});
      const rejection = expect(approving).rejects.toMatchObject({
        code: "not_found",
      });
      const description = await f.socket.nextFrame();
      if (reason === "foreign") {
        f.socket.receive({
          type: "res",
          id: description.id,
          ok: false,
          error: { code: "not_found", message: "Request belongs to another Gateway" },
        });
      } else {
        f.socket.acknowledge(description, {
          ...REQUEST_DETAILS,
          ...(reason === "expired" ? { expiresAt: f.scheduler.now() } : { kind: undefined }),
        });
      }
      await rejection;
      await expect(f.state.grants()).resolves.toEqual([]);
      expect(f.socket.frames.some((frame) => frame.op === "authorize.approve")).toBe(false);
    },
  );

  it("revokes a locally recorded grant when the relay refuses the approval", async () => {
    const f = await fixture();
    await f.ready();
    const approving = f.service.consent.approve(REQUEST_ID, PERSON_AUTHORITY, () => {});
    const rejection = expect(approving).rejects.toMatchObject({ code: "not_found" });
    f.socket.acknowledge(await f.socket.nextFrame(), REQUEST_DETAILS);
    const approval = await f.socket.nextFrame();
    f.socket.receive({
      type: "res",
      id: approval.id,
      ok: false,
      error: { code: "not_found", message: "Request expired" },
    });
    const revocation = await f.socket.nextFrame();
    expect(revocation).toMatchObject({ op: "grant.revoke" });
    const grants = await f.state.grants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ revokedAt: 1_000, ...PERSON_AUTHORITY });
    f.socket.acknowledge(revocation);
    await rejection;
  });

  it("acknowledges grant creation only after durable consumption and maps all rejected codes to not_found", async () => {
    const f = await fixture();
    await f.ready();
    const request = (id: string, hash: string) =>
      f.request({
        id,
        op: "grant.create",
        params: { grantId: id, codeHash: hash, client: CLIENT },
      });
    expect(await request("unknown", codeHash("unknown"))).toEqual(denied("unknown", "not_found"));
    await f.state.issue(codeHash("expired"), f.scheduler.now(), f.scheduler.now() - 1);
    expect(await request("expired", codeHash("expired"))).toEqual(denied("expired", "not_found"));
    await f.state.issue(codeHash("issued"), f.scheduler.now() + 1_000, f.scheduler.now());
    const persist = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await persist.promise;
    };
    const framesBeforeCommit = f.socket.frames.length;
    f.socket.receive({
      type: "req",
      id: "accepted",
      op: "grant.create",
      params: { grantId: "accepted", codeHash: codeHash("issued"), client: CLIENT },
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    expect(f.socket.frames).toHaveLength(framesBeforeCommit);
    persist.resolve();
    await dispatch;
    expect(await f.socket.nextFrame()).toEqual({
      type: "res",
      id: "accepted",
      ok: true,
      result: {},
    });
    await expect(f.storage.open().grants()).resolves.toEqual([
      {
        grantId: "accepted",
        clientId: CLIENT.id,
        clientName: CLIENT.name,
        createdAt: 1_000,
        principal: { kind: "owner" },
        ceiling: ["operator.read", "operator.write"],
      },
    ]);
    expect(await request("consumed", codeHash("issued"))).toEqual(denied("consumed", "not_found"));
  });

  it("refuses unknown and revoked grants before calling data operations and records valid use", async () => {
    const operations = vi.fn(async () => ({ gateway: { name: "Synthetic Gateway" } }));
    const f = await fixture(operations);
    await createGrant(f);
    await f.ready();
    const request = (id: string, grantId: string) =>
      f.request({ id, op: "status", params: {}, grantId });
    expect(await request("unknown", "gr_missing")).toEqual(denied("unknown", "grant_revoked"));
    expect(operations).not.toHaveBeenCalled();
    await f.clock.advanceBy(25);
    expect(await request("valid", "gr_one")).toMatchObject({ ok: true });
    expect(operations).toHaveBeenCalledWith(
      "status",
      {},
      expect.any(Function),
      expect.any(Function),
    );
    expect((await f.state.grants())[0]?.lastUsedAt).toBe(1_025);
    expect(
      await f.request({
        id: "revoked",
        op: "grant.revoked",
        params: { grantId: "gr_one", reason: "refresh_reuse" },
      }),
    ).toEqual({ type: "res", id: "revoked", ok: true, result: {} });
    expect(await request("denied", "gr_one")).toEqual(denied("denied", "grant_revoked"));
    expect(operations).toHaveBeenCalledOnce();
    expect(
      await f.request({
        id: "early-revocation",
        op: "grant.revoked",
        params: { grantId: "gr_early", reason: "client_revoked" },
      }),
    ).toEqual({ type: "res", id: "early-revocation", ok: true, result: {} });
    const hash = codeHash("late-creation");
    await f.state.issue(hash, f.scheduler.now() + 1_000, f.scheduler.now());
    expect(
      await f.request({
        id: "late-creation",
        op: "grant.create",
        params: { grantId: "gr_early", codeHash: hash, client: CLIENT },
      }),
    ).toEqual(denied("late-creation", "not_found"));
    expect(await request("still-revoked", "gr_early")).toEqual(
      denied("still-revoked", "grant_revoked"),
    );
  });

  it("persists a local revocation before sending grant.revoke", async () => {
    const f = await fixture();
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    const persist = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await persist.promise;
    };
    const revoking = f.service.revoke("gr_one");
    await entered.promise;
    expect(f.socket.frames).toHaveLength(1);
    persist.resolve();
    const request = await f.socket.nextFrame();
    expect(request).toEqual({
      type: "req",
      id: expect.any(String),
      op: "grant.revoke",
      params: { grantId: "gr_one" },
    });
    expect((await f.storage.open().grants())[0]?.revokedAt).toBe(1_000);
    f.socket.acknowledge(request);
    await expect(revoking).resolves.toEqual({ revoked: true, relayNotified: true });
  });

  it("replays an offline revocation after authentication on the next connection", async () => {
    const f = await fixture();
    await createGrant(f);
    await expect(f.service.revoke("gr_one")).resolves.toEqual({
      revoked: true,
      relayNotified: false,
    });
    await f.ready();
    // Replay waits for an acknowledgement; keep its scheduled callback in flight.
    const replay = f.clock.advanceBy(0);
    const request = await f.socket.nextFrame();
    expect(request).toMatchObject({ op: "grant.revoke", params: { grantId: "gr_one" } });
    expect((await f.storage.open().grants())[0]?.revokedAt).toBe(1_000);
    f.socket.acknowledge(request);
    await replay;
  });

  it("withholds an awaited data result if its grant was revoked meanwhile", async () => {
    const result = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async () => {
      entered.resolve();
      return result.promise;
    });
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    f.socket.receive({
      type: "req",
      id: "read",
      op: "conversation.read",
      grantId: "gr_one",
      params: {},
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    await f.state.revoke("gr_one", f.scheduler.now());
    result.resolve({ messages: [{ text: "Private result" }] });
    await dispatch;
    expect(await f.socket.nextFrame()).toEqual(denied("read", "grant_revoked"));
  });

  it("terminates and reconnects when no pong arrives within two keepalive intervals", async () => {
    const f = await fixture();
    await f.ready();
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(30_000);
    expect(await f.socket.nextFrame()).toEqual({ type: "ping" });
    await f.clock.advanceBy(29_999);
    expect(f.socket.closes).toEqual([]);
    await f.clock.advanceBy(1);
    expect(f.socket.closes).toEqual([{ code: 1001, reason: "Relay keepalive timed out" }]);
    expect(f.socket.terminated).toBe(true);
    await expect(f.service.status()).resolves.toMatchObject({ connected: false });
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it("joins retired connection scopes even when the socket factory fails", async () => {
    const f = await fixture();
    const openScope = f.scheduler.scope;
    const scopes = vi.spyOn(f.scheduler, "scope").mockImplementation(() => {
      const child = openScope();
      vi.spyOn(child, "stop");
      return child;
    });
    f.socket.close(4409);
    await f.clock.advanceBy(0);
    f.effects.connectError = new Error("Synthetic connection failure");
    await f.clock.advanceBy(1_000);
    await f.clock.advanceBy(0);
    expect(scopes).toHaveBeenCalledOnce();
    const failedScope = scopes.mock.results[0];
    if (failedScope?.type !== "return") {
      throw new Error("Expected a connection scope");
    }
    expect(failedScope.value.signal.aborted).toBe(true);
    expect(failedScope.value.stop).toHaveBeenCalledOnce();
    f.effects.connectError = undefined;
    await f.clock.advanceBy(2_000);
    expect(f.sockets).toHaveLength(2);
    const reconnectedScope = scopes.mock.results[1];
    if (reconnectedScope?.type !== "return") {
      throw new Error("Expected a replacement connection scope");
    }
    f.sockets[1]?.close(4409);
    await f.clock.advanceBy(0);
    expect(reconnectedScope.value.signal.aborted).toBe(true);
    expect(reconnectedScope.value.stop).toHaveBeenCalledOnce();
  });

  it("rejects pending relay requests before joining their closing connection scope", async () => {
    const f = await fixture();
    await createGrant(f);
    await f.service.revoke("gr_one");
    await f.ready();
    const replay = f.clock.advanceBy(0);
    const request = await f.socket.nextFrame();
    expect(request).toMatchObject({ op: "grant.revoke" });
    f.socket.close(4409);
    await replay;
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    expect(f.sockets).toHaveLength(2);
  });

  it.each(["revoked", "disconnected"])(
    "rechecks %s authority after operation preparation without blocking unrelated requests",
    async (change) => {
      const prepared = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const mutate = vi.fn();
      const f = await fixture(async (op, _params, assertAuthority) => {
        if (op === "message.send") {
          prepared.resolve();
          await resume.promise;
          await assertAuthority();
          mutate();
        }
        return {};
      });
      await createGrant(f);
      await f.ready();
      await f.clock.advanceBy(0);
      f.socket.receive({
        type: "req",
        id: "send",
        op: "message.send",
        grantId: "gr_one",
        params: {},
      });
      const sending = f.clock.advanceBy(0);
      await prepared.promise;
      expect(
        await f.request({
          id: "status",
          op: "status",
          grantId: "gr_one",
          params: {},
        }),
      ).toEqual({ type: "res", id: "status", ok: true, result: { ui: unavailableUi } });
      if (change === "revoked") {
        await f.state.revoke("gr_one", f.scheduler.now());
      } else {
        f.socket.close(4409);
      }
      resume.resolve();
      await sending;
      expect(mutate).not.toHaveBeenCalled();
      if (change === "revoked") {
        expect(await f.socket.nextFrame()).toEqual(denied("send", "grant_revoked"));
      } else {
        expect(f.socket.frames.some((frame) => frame.id === "send")).toBe(false);
      }
    },
  );

  it("rechecks the connection after an awaited grant authorization before dispatching", async () => {
    const operations = vi.fn(async () => ({}));
    const f = await fixture(operations);
    await createGrant(f);
    await f.ready();
    await f.clock.advanceBy(0);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    f.storage.effects.beforeCompare = async () => {
      entered.resolve();
      await resume.promise;
    };
    f.socket.receive({
      type: "req",
      id: "send",
      op: "message.send",
      grantId: "gr_one",
      params: {},
    });
    const dispatch = f.clock.advanceBy(0);
    await entered.promise;
    f.socket.close(4409);
    resume.resolve();
    await dispatch;
    expect(operations).not.toHaveBeenCalled();
    expect(f.socket.frames.some((frame) => frame.id === "send")).toBe(false);
  });

  it("rejects an oversized incoming frame before dispatch", async () => {
    const f = await fixture();
    f.socket.emit("message", Buffer.alloc(1024 * 1024 + 1, 32), false);
    expect(f.socket.closes).toEqual([{ code: 1009, reason: "Frame too large" }]);
  });

  it.each(["operation", "unavailable UI"])(
    "bounds queued %s output on the shared relay socket",
    async (kind) => {
      const f = await fixture();
      await createGrant(f);
      await f.ready();
      await f.clock.advanceBy(0);
      f.socket.bufferedAmount = 32 * 1024 * 1024 - 10;
      f.socket.receive(
        kind === "operation"
          ? { type: "req", id: "status", op: "status", grantId: "gr_one", params: {} }
          : HTTP,
      );
      await f.clock.advanceBy(0);
      expect(f.socket.closes).toEqual([
        { code: 1011, reason: "Relay output buffer limit exceeded" },
      ]);
      expect(f.socket.terminated).toBe(true);
      expect(f.socket.frames).toHaveLength(1);
    },
  );

  it.each([null, {}, { frameAncestors: "https://chatgpt.com" }, { frameAncestors: [1] }])(
    "rejects malformed ready UI metadata: %j",
    async (ui) => {
      const f = await fixture();
      await f.ready(f.socket, ui);
      expect(f.socket.closes).toEqual([{ code: 4400, reason: "Invalid UI capability" }]);
    },
  );

  it("keeps person UI and MCP access available after an old owner grant fails admission", async () => {
    const reason = "Re-pair as a person from the Connected apps tab.";
    const handle = {
      presentation: { ...ORIGINS, basePath: "/control", operatorScopeCeiling: ["operator.read"] },
      request: async () => ({ response: new Response("person UI"), pluginReadCookies: [] }),
      openWebSocket: async () => ({ socket: new IngressSocket() }),
      close: vi.fn(async () => {}),
    } satisfies GatewayControlUiIngressV1;
    const ingress = createPrincipalIngress(handle);
    const bind = ingress.factory.bindPrincipal.getMockImplementation()!;
    ingress.factory.bindPrincipal.mockImplementation(async (options) => {
      if (options.principal.kind === "owner") {
        throw new GatewayControlUiIngressError("unsupported-auth", reason);
      }
      return bind(options);
    });
    const f = await fixture(undefined, {
      controlUiIngress: ingress.factory,
      config: () => ({ gateway: { controlUi: { basePath: " /control/ " } } }),
    });
    await createGrant(f);
    await f.state.approveGrant(
      {
        grantId: "gr_person",
        clientId: CLIENT.id,
        clientName: CLIENT.name,
        createdAt: f.scheduler.now(),
        principal: { kind: "person", profileId: "profile-private" },
        ceiling: ["operator.read"],
      },
      () => {},
    );
    await f.ready();
    expect((await f.service.status()).ui).toEqual(unavailableUi);
    f.socket.close(4409);
    await f.clock.advanceBy(0);
    await f.clock.advanceBy(1_000);
    const socket = f.sockets[1]!;
    await f.ready(socket, uiCapability);
    expect((await f.service.status()).ui).toEqual({ available: true, basePath: "/control" });
    expect(ingress.factory.bindPrincipal).not.toHaveBeenCalled();
    socket.receive(HTTP);
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toEqual({
      type: "ui.error",
      sid: HTTP.sid,
      code: "unavailable",
      message: reason,
    });
    expect((await f.service.status()).ui).toEqual({ available: true, basePath: "/control" });
    socket.receive({ ...HTTP, sid: "person01", grantId: "gr_person" });
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toMatchObject({ type: "ui.http.head", status: 200 });
    expect(await socket.nextFrame()).toMatchObject({
      type: "ui.http.body",
      b64: Buffer.from("person UI").toString("base64"),
    });
    expect(await socket.nextFrame()).toMatchObject({ type: "ui.http.body", more: false });
    socket.receive({
      type: "req",
      id: "person-status",
      op: "status",
      grantId: "gr_person",
      params: {},
    });
    await f.clock.advanceBy(0);
    expect(await socket.nextFrame()).toMatchObject({ id: "person-status", ok: true });
    expect(ingress.factory.bindPrincipal).toHaveBeenCalledTimes(2);
    expect(ingress.bindings[0]?.options).toMatchObject({
      audienceId: "gr_person",
      principal: { kind: "person", profileId: "profile-private" },
      operatorScopeCeiling: ["operator.read"],
    });
    expect(JSON.stringify(socket.frames)).not.toContain("profile-private");
    expect(ingress.factory.open).not.toHaveBeenCalled();
  });

  it("closes the grant handle and browser socket when the operator revokes through the service", async () => {
    const browser = new IngressSocket();
    const handle = {
      presentation: {
        ...ORIGINS,
        basePath: "/",
        operatorScopeCeiling: ["operator.read", "operator.write"],
      },
      request: async () => ({ response: new Response("index"), pluginReadCookies: [] }),
      openWebSocket: async () => ({ socket: browser }),
      close: vi.fn(async () => {
        browser.close();
      }),
    } satisfies GatewayControlUiIngressV1;
    const f = await fixture(undefined, {
      controlUiIngress: createPrincipalIngress(handle).factory,
    });
    await createGrant(f);
    await f.ready(f.socket, uiCapability);
    f.socket.receive(WS);
    const opening = f.clock.advanceBy(0);
    expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.ws.opened" });
    const revoking = f.service.revoke("gr_one");
    expect(await f.socket.nextFrame()).toMatchObject({ type: "ui.error", code: "grant_revoked" });
    const notification = await f.socket.nextFrame();
    expect(notification).toMatchObject({ op: "grant.revoke" });
    f.socket.acknowledge(notification);
    await revoking;
    await opening;
    expect(browser.closes[0]?.code).toBe(1008);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(() => f.state.assertGrantCurrent("gr_one")).toThrow("revoked");
  });

  it("aborts pending ingress HTTP and closes its handle when the relay disconnects", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const handle = {
      presentation: { ...ORIGINS, basePath: "/", operatorScopeCeiling: ["operator.read"] },
      request: async ({ signal }) => {
        entered.resolve(signal);
        return abortable<Awaited<ReturnType<GatewayControlUiIngressV1["request"]>>>(signal);
      },
      openWebSocket: async () => ({ socket: new IngressSocket() }),
      close: vi.fn(async () => {}),
    } satisfies GatewayControlUiIngressV1;
    const f = await fixture(undefined, {
      controlUiIngress: createPrincipalIngress(handle).factory,
    });
    await createGrant(f);
    await f.ready(f.socket, uiCapability);
    f.socket.receive(HTTP);
    const dispatch = f.clock.advanceBy(0);
    const signal = await entered.promise;
    f.socket.close(4409);
    await dispatch;
    expect(signal.aborted).toBe(true);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(f.socket.frames).toHaveLength(1);
  });
});
