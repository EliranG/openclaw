import { generateKeyPairSync } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { GatewayIngressPrincipal } from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { identityFromPrivateKey, RelayError } from "./protocol.js";

export type RelayGrantAuthority = {
  readonly principal: Readonly<GatewayIngressPrincipal>;
  readonly ceiling: readonly string[];
  readonly principalLabel?: string;
};

export type IssuedRelayGrant = RelayGrantAuthority & {
  grantId: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type RelayGrant =
  | IssuedRelayGrant
  | { grantId: string; revokedAt: number; lastUsedAt?: never };

type PairingCode = RelayGrantAuthority & {
  codeHash: string;
  expiresAt: number;
  consumed: boolean;
};
type RelayRecord = {
  version: 2;
  relayOrigin: string;
  privateKey: string;
  codes: PairingCode[];
  grants: RelayGrant[];
};

const RECORD_KEY = "authority";
const MAX_CODES = 100;
const MAX_GRANTS = 1_000;
const MAX_BYTES = 512 * 1024;
const OWNER_AUTHORITY: RelayGrantAuthority = {
  principal: { kind: "owner" },
  ceiling: ["operator.read", "operator.write"],
};

function stateError(): RelayError {
  return new RelayError(
    "unavailable",
    "MCP relay state is missing or invalid. Restore a valid OpenClaw state backup before enabling the plugin again.",
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseAuthority(value: Record<string, unknown>): RelayGrantAuthority {
  const { principal, ceiling, principalLabel } = value;
  if (
    !isRecord(principal) ||
    !Array.isArray(ceiling) ||
    !ceiling.every((scope): scope is string => typeof scope === "string" && scope.length > 0) ||
    (principalLabel !== undefined && typeof principalLabel !== "string")
  ) {
    throw stateError();
  }
  let parsedPrincipal: GatewayIngressPrincipal;
  if (principal.kind === "owner") {
    parsedPrincipal = { kind: "owner" };
  } else if (
    principal.kind === "person" &&
    typeof principal.profileId === "string" &&
    principal.profileId.trim()
  ) {
    parsedPrincipal = { kind: "person", profileId: principal.profileId };
  } else {
    throw stateError();
  }
  return {
    principal: parsedPrincipal,
    ceiling: [...ceiling],
    ...(principalLabel === undefined ? {} : { principalLabel }),
  };
}

function parseCode(value: unknown, legacy: boolean): PairingCode {
  if (
    !isRecord(value) ||
    typeof value.codeHash !== "string" ||
    !timestamp(value.expiresAt) ||
    typeof value.consumed !== "boolean"
  ) {
    throw stateError();
  }
  return {
    codeHash: value.codeHash,
    expiresAt: value.expiresAt,
    consumed: value.consumed,
    ...(legacy ? OWNER_AUTHORITY : parseAuthority(value)),
  };
}

function parseGrant(value: unknown, legacy: boolean): RelayGrant {
  if (!isRecord(value) || typeof value.grantId !== "string") {
    throw stateError();
  }
  if (Object.keys(value).every((key) => key === "grantId" || key === "revokedAt")) {
    if (!timestamp(value.revokedAt)) {
      throw stateError();
    }
    return { grantId: value.grantId, revokedAt: value.revokedAt };
  }
  if (
    typeof value.clientId !== "string" ||
    typeof value.clientName !== "string" ||
    !timestamp(value.createdAt) ||
    (value.lastUsedAt !== undefined && !timestamp(value.lastUsedAt)) ||
    (value.revokedAt !== undefined && !timestamp(value.revokedAt))
  ) {
    throw stateError();
  }
  return {
    grantId: value.grantId,
    clientId: value.clientId,
    clientName: value.clientName,
    createdAt: value.createdAt,
    ...(legacy ? OWNER_AUTHORITY : parseAuthority(value)),
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  };
}

function parseRecord(value: unknown, migrateLegacy: boolean): RelayRecord {
  if (
    !isRecord(value) ||
    (value.version !== 2 && !(migrateLegacy && value.version === 1)) ||
    typeof value.relayOrigin !== "string" ||
    typeof value.privateKey !== "string" ||
    !Array.isArray(value.codes) ||
    !Array.isArray(value.grants)
  ) {
    throw stateError();
  }
  const record: RelayRecord = {
    version: 2,
    relayOrigin: value.relayOrigin,
    privateKey: value.privateKey,
    codes: value.codes.map((code) => parseCode(code, value.version === 1)),
    grants: value.grants.map((grant) => parseGrant(grant, value.version === 1)),
  };
  if (
    new Set(record.codes.map((code) => code.codeHash)).size !== record.codes.length ||
    new Set(record.grants.map((grant) => grant.grantId)).size !== record.grants.length
  ) {
    throw stateError();
  }
  return record;
}

function assertCapacity(record: RelayRecord): void {
  // Reserve every grant's future timestamps so a full store can still revoke.
  const reserved = {
    ...record,
    grants: record.grants.map((grant) =>
      "createdAt" in grant
        ? {
            ...grant,
            lastUsedAt: Number.MAX_SAFE_INTEGER,
            revokedAt: Number.MAX_SAFE_INTEGER,
          }
        : grant,
    ),
  };
  if (
    record.codes.length > MAX_CODES ||
    record.grants.length > MAX_GRANTS ||
    Buffer.byteLength(JSON.stringify(reserved), "utf8") > MAX_BYTES
  ) {
    throw new RelayError(
      "unavailable",
      "MCP relay state capacity is reached. Wait for unused pairing codes to expire; if pairing still fails, contact your OpenClaw administrator.",
    );
  }
}

export class RelayState {
  readonly #store: PluginStateKeyedStore<unknown>;
  readonly #relayOrigin: string;
  readonly #assertCurrent: () => void;
  readonly #now: () => number;
  readonly #activeGrants = new Map<string, Readonly<IssuedRelayGrant>>();
  #updates: Promise<void> = Promise.resolve();

  constructor(
    runtime: Pick<PluginRuntime, "state">,
    relayUrl: string,
    assertCurrent: () => void,
    now: () => number = Date.now,
  ) {
    this.#relayOrigin = new URL(relayUrl).origin;
    this.#assertCurrent = assertCurrent;
    this.#now = now;
    this.#store = runtime.state.openKeyedStore<unknown>({
      namespace: "mcp-relay-authority",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
  }

  #currentStore(assertOperationCurrent?: () => void): PluginStateKeyedStore<unknown, 2> {
    if (!this.#store.withCurrent) {
      throw new RelayError(
        "unavailable",
        "MCP relay requires current plugin-state authority support. Update OpenClaw and restart the Gateway.",
      );
    }
    return this.#store.withCurrent({
      assertCurrent: () => {
        this.#assertCurrent();
        assertOperationCurrent?.();
      },
    });
  }

  #record(value: unknown, migrateLegacy = false): RelayRecord {
    const record = parseRecord(value, migrateLegacy);
    if (record.relayOrigin !== this.#relayOrigin) {
      throw new RelayError(
        "unavailable",
        `MCP relay identity is bound to ${record.relayOrigin}. Restore the matching relayUrl in the plugin configuration.`,
      );
    }
    return record;
  }

  async initialize(): Promise<{ privateKey: string }> {
    const store = this.#currentStore();
    let observation = await store.observe(RECORD_KEY);
    let candidate: RelayRecord | undefined;
    for (;;) {
      if (observation.value !== undefined) {
        const record = this.#record(observation.value, true);
        try {
          identityFromPrivateKey(record.privateKey);
        } catch {
          throw stateError();
        }
        if (isRecord(observation.value) && observation.value.version === 2) {
          this.#publishGrants(record);
          return { privateKey: record.privateKey };
        }
        // Added authority metadata must not strand a full legacy store; only new admissions use the budget.
        candidate = record;
      }
      candidate ??= {
        version: 2,
        relayOrigin: this.#relayOrigin,
        privateKey: generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
        codes: [],
        grants: [],
      };
      const result = await store.compareAndApply(RECORD_KEY, observation.comparison, {
        operation: "update",
        action: "set",
        value: candidate,
      });
      if (result.status !== "conflict") {
        this.#publishGrants(candidate);
        return { privateKey: candidate.privateKey };
      }
      observation = result.current;
    }
  }

  async #update<T>(
    decide: (record: RelayRecord) => { value?: RelayRecord; result: T },
    assertOperationCurrent?: () => void,
  ): Promise<T> {
    // Publish grant authority in the same order as this owner's durable mutations.
    const update = this.#updates.then(() => this.#applyUpdate(decide, assertOperationCurrent));
    this.#updates = update.then(
      () => {},
      () => {},
    );
    return update;
  }

  #publishGrants(record: RelayRecord): void {
    this.#activeGrants.clear();
    for (const grant of record.grants) {
      if ("createdAt" in grant && grant.revokedAt === undefined) {
        this.#activeGrants.set(
          grant.grantId,
          Object.freeze({
            ...grant,
            principal: Object.freeze({ ...grant.principal }),
            ceiling: Object.freeze([...grant.ceiling]),
          }),
        );
      }
    }
  }

  assertGrantCurrent(grantId: string): void {
    if (!this.getGrant(grantId)) {
      throw new RelayError(
        "grant_revoked",
        "This connection was revoked. Run openclaw mcp-relay pair and connect again.",
      );
    }
  }

  getGrant(grantId: string): Readonly<IssuedRelayGrant> | undefined {
    this.#assertCurrent();
    return this.#activeGrants.get(grantId);
  }

  async #applyUpdate<T>(
    decide: (record: RelayRecord) => { value?: RelayRecord; result: T },
    assertOperationCurrent?: () => void,
  ): Promise<T> {
    const store = this.#currentStore(assertOperationCurrent);
    let observation = await store.observe(RECORD_KEY);
    for (;;) {
      const record = this.#record(observation.value);
      const decision = decide(record);
      const result = await store
        .compareAndApply(
          RECORD_KEY,
          observation.comparison,
          decision.value
            ? { operation: "update", action: "set", value: decision.value }
            : { operation: "update", action: "keep" },
        )
        .catch((error: unknown) => {
          // An uncertain write may have revoked a grant. Fail closed until a successful reread.
          this.#activeGrants.clear();
          throw error;
        });
      if (result.status !== "conflict") {
        this.#publishGrants(decision.value ?? record);
        return decision.result;
      }
      observation = result.current;
    }
  }

  async issue(
    codeHash: string,
    expiresAt: number,
    now: number,
    assertCommandCurrent?: () => void,
    authority: RelayGrantAuthority = OWNER_AUTHORITY,
  ): Promise<void> {
    const issuedAuthority = parseAuthority(authority);
    await this.#update((record) => {
      const codes = record.codes.filter((code) => code.expiresAt > now);
      if (codes.some((code) => code.codeHash === codeHash)) {
        throw new RelayError(
          "unavailable",
          "Pairing code already issued. Run openclaw mcp-relay pair again.",
        );
      }
      const value = {
        ...record,
        codes: [...codes, { codeHash, expiresAt, consumed: false, ...issuedAuthority }],
      };
      assertCapacity(value);
      return { value, result: undefined };
    }, assertCommandCurrent);
  }

  async createGrant(
    params: { grantId: string; codeHash: string; client: { id: string; name: string } },
    now: number,
  ): Promise<boolean> {
    let selectedExpiresAt: number | undefined;
    return this.#update(
      (record) => {
        const code = record.codes.find((entry) => entry.codeHash === params.codeHash);
        if (
          !code ||
          code.consumed ||
          code.expiresAt <= Math.max(now, this.#now()) ||
          record.grants.some((grant) => grant.grantId === params.grantId)
        ) {
          selectedExpiresAt = undefined;
          return { result: false };
        }
        selectedExpiresAt = code.expiresAt;
        const value: RelayRecord = {
          ...record,
          codes: record.codes.map((entry) =>
            entry === code ? { ...entry, consumed: true } : entry,
          ),
          grants: [
            ...record.grants,
            {
              grantId: params.grantId,
              clientId: params.client.id,
              clientName: params.client.name,
              createdAt: now,
              principal: code.principal,
              ceiling: code.ceiling,
              ...(code.principalLabel === undefined ? {} : { principalLabel: code.principalLabel }),
            },
          ],
        };
        assertCapacity(value);
        return { value, result: true };
      },
      () => {
        if (selectedExpiresAt !== undefined && selectedExpiresAt <= this.#now()) {
          throw new RelayError(
            "not_found",
            "That pairing code expired before the grant was saved. Run openclaw mcp-relay pair again.",
          );
        }
      },
    );
  }

  async approveGrant(
    grant: Omit<IssuedRelayGrant, "lastUsedAt" | "revokedAt">,
    assertCommandCurrent: () => void,
  ): Promise<boolean> {
    const approvedGrant = parseGrant(grant, false);
    return this.#update((record) => {
      if (record.grants.some((entry) => entry.grantId === grant.grantId)) {
        return { result: false };
      }
      const value = { ...record, grants: [...record.grants, approvedGrant] };
      assertCapacity(value);
      return { value, result: true };
    }, assertCommandCurrent);
  }

  async authorize(grantId: string, now: number): Promise<Readonly<IssuedRelayGrant> | undefined> {
    const authorized = await this.#update((record) => {
      const grant = record.grants.find((entry) => entry.grantId === grantId);
      if (!grant || !("createdAt" in grant) || grant.revokedAt !== undefined) {
        return { result: false };
      }
      const usedGrant: IssuedRelayGrant = { ...grant, lastUsedAt: now };
      return {
        value: {
          ...record,
          grants: record.grants.map((entry) => (entry === grant ? usedGrant : entry)),
        },
        result: true,
      };
    });
    return authorized ? this.getGrant(grantId) : undefined;
  }

  async revoke(grantId: string, now: number, assertCommandCurrent?: () => void): Promise<boolean> {
    return this.#revoke(grantId, now, false, assertCommandCurrent);
  }

  async recordRevocation(grantId: string, now: number): Promise<void> {
    await this.#revoke(grantId, now, true);
  }

  async #revoke(
    grantId: string,
    now: number,
    recordUnknown: boolean,
    assertCommandCurrent?: () => void,
  ): Promise<boolean> {
    return this.#update((record) => {
      const grant = record.grants.find((entry) => entry.grantId === grantId);
      if (!grant) {
        if (!recordUnknown) {
          return { result: false };
        }
        const value = {
          ...record,
          grants: [...record.grants, { grantId, revokedAt: now }],
        };
        assertCapacity(value);
        return { value, result: true };
      }
      if (grant.revokedAt !== undefined) {
        return { result: true };
      }
      return {
        value: {
          ...record,
          grants: record.grants.map((entry) =>
            entry === grant ? { ...entry, revokedAt: now } : entry,
          ),
        },
        result: true,
      };
    }, assertCommandCurrent);
  }

  async grants(): Promise<RelayGrant[]> {
    return this.#record(await this.#currentStore().lookup(RECORD_KEY)).grants;
  }
}
