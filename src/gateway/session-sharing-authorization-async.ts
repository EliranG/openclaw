import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveChatSendAuthorizationParams,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  request: Parameters<typeof resolveSessionMutationAuthorization>[0] & {
    assertInvocationCurrent?: () => void;
  },
): Promise<ReturnType<typeof resolveSessionMutationAuthorization>> {
  let params = request;
  params.assertInvocationCurrent?.();
  if (params.method === "chat.send") {
    const normalized = resolveChatSendAuthorizationParams(
      params.context.getRuntimeConfig(),
      params.requestParams,
    );
    if (!normalized.ok) {
      return { error: normalized.error };
    }
    params = { ...params, requestParams: normalized.value };
  }
  const talk = resolveTalkSessionTargetInput(
    params.method,
    params.requestParams,
    params.client?.connId,
  );
  if (talk && !params.preparedTalkSessionTarget) {
    try {
      params = {
        ...params,
        preparedTalkSessionTarget:
          talk.kind === "relay"
            ? talk.target
            : await prepareTalkSessionTarget(params.context.getRuntimeConfig(), talk.sessionKey),
      };
    } catch (error) {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          String(error instanceof Error ? error.message : error),
        ),
      };
    }
    params.assertInvocationCurrent?.();
  }
  const targets = params.preparedTalkSessionTarget
    ? [
        {
          sessionKey: params.preparedTalkSessionTarget.canonicalKey,
          agentId: params.preparedTalkSessionTarget.agentId,
        },
      ]
    : [
        ...resolveDirectSessionTargets(params.method, params.requestParams),
        ...(resolveSessionMutationTargets(params) ?? []),
      ];
  const cfg = params.context.getRuntimeConfig();
  const preparedProfiles = await prepareSessionSharingProfiles(params.client);
  const reads: Array<{ release: () => void }> = [];
  const creationReleases: Array<() => void> = [];
  let active = true;
  let transferred = false;
  const release = () => {
    active = false;
    for (const read of reads.splice(0)) {
      read.release();
    }
    for (const stop of creationReleases.splice(0)) {
      stop();
    }
  };
  try {
    const uniqueTargets = targets.filter(
      (target, index) =>
        targets.findIndex(
          (candidate) =>
            candidate.sessionKey === target.sessionKey && candidate.agentId === target.agentId,
        ) === index,
    );
    const preparedTargets: (NonNullable<
      SessionMutationAuthorizationParams["preparedTargets"]
    >[number] & {
      storageTarget: import("./session-sharing-read.js").PreparedMutationSharing["storageTarget"];
    })[] = [];
    for (const target of uniqueTargets) {
      const input = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
      if (!input.ok) {
        release();
        return { error: input.error };
      }
      const retained = await prepareSessionMutationFacts({
        cfg,
        sessionKey: target.sessionKey,
        agentId: input.agentId,
        allowMissing: true,
      });
      reads.push(retained);
      const initialFacts = retained.readCurrent(cfg);
      const sourcePath = initialFacts.sourcePath;
      const sourceIdentity = sourcePath && readDatabasePathIdentitySync(sourcePath);
      const readSource =
        sourcePath && sourceIdentity
          ? {
              agentId: initialFacts.sourceAgentId ?? input.agentId,
              path: sourcePath,
              databaseIdentity: sourceIdentity.key.slice("file:".length),
              databaseBirthtime: sourceIdentity.birthtime,
            }
          : undefined;
      preparedTargets.push({
        ...target,
        storageTarget: retained.storageTarget,
        readSource,
        bindCreation: retained.bindCreation,
        read: () => {
          const facts = retained.readCurrent(params.context.getRuntimeConfig());
          return {
            target: facts.target && { ...facts.target, readSource },
            storageTarget: retained.storageTarget,
            members: [],
            isMember: (identityId: string) => facts.membership.has(identityId),
            assertCurrent: () => {
              retained.readCurrent(params.context.getRuntimeConfig());
            },
          };
        },
      });
    }
    params.assertInvocationCurrent?.();
    const result = resolveSessionMutationAuthorization({
      ...params,
      preparedProfiles,
      preparedTargets,
    });
    if (!result.authorization) {
      release();
      return result;
    }
    const authorization = result.authorization;
    return {
      ...result,
      authorization: {
        ...authorization,
        release: () => {
          if (!transferred) {
            release();
          }
        },
        takeRelease: () => {
          transferred = true;
          return release;
        },
        recordCreatedSession: (created) => {
          authorization.recordCreatedSession?.(created);
          if (!created.entry) {
            return;
          }
          const path = created.readSource?.path ?? created.storePath;
          const identity = readDatabasePathIdentitySync(path);
          const retained = retainPreparedSessionSharingFacts({
            databaseIdentity: identity.key,
            sessionKey: created.sessionKey,
            entry: projectSessionSharingEntry(created.entry),
            membership: new Set(),
          });
          creationReleases.push(retained.release);
          const read = () => {
            const current = retained.readCurrent();
            if (!active || !current?.entry) {
              throw new Error("Created session authority is no longer current");
            }
            return {
              target: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storeKey: created.sessionKey,
                storeKeys: [created.sessionKey],
                storePath: created.storePath,
                readSource: created.readSource,
                entry: current.entry,
              },
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              members: [],
              isMember: (identityId: string) => current.membership.has(identityId),
              assertCurrent: () => {
                if (!active || !retained.readCurrent()) {
                  throw new Error("Created session authority is no longer current");
                }
              },
            };
          };
          const selected = preparedTargets.find(
            (target) =>
              target.storageTarget.canonicalKey === created.sessionKey &&
              target.storageTarget.agentId === created.agentId,
          );
          if (selected) {
            selected.read = read;
            selected.readSource = created.readSource ?? selected.readSource;
          } else {
            preparedTargets.push({
              sessionKey: created.sessionKey,
              agentId: created.agentId,
              storageTarget: {
                agentId: created.agentId,
                canonicalKey: created.sessionKey,
                storePath: created.storePath,
              },
              readSource: created.readSource,
              read,
              bindCreation: () => {},
            });
          }
        },
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
