import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_PROVIDER_ID as PROVIDER_ID,
} from "./defaults.js";
import { discoverLmstudioModels } from "./models.fetch.js";
import {
  normalizeLmstudioModelKey,
  resolveLmstudioCanonicalModelKey,
  resolveLmstudioInferenceBase,
  resolveLmstudioServerBase,
} from "./models.js";
import {
  hasLmstudioAuthorizationHeader,
  resolveLmstudioProviderAuthMode,
  resolvePersistedLmstudioApiKey,
} from "./provider-auth.js";
import {
  LmstudioConfigResolutionError,
  resolveLmstudioConfiguredApiKey,
  resolveLmstudioProviderHeaders,
} from "./runtime.js";

/** Acquires live inventory for the registered catalog; public helper calls stay advisory. */
export function discoverLmstudioProvider(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null>;
export function discoverLmstudioProvider(
  ctx: ProviderCatalogContext,
  options: { discoveryMode: "strict" },
): Promise<ProviderCatalogResult>;
export async function discoverLmstudioProvider(
  ctx: ProviderCatalogContext,
  options?: { discoveryMode: "strict" },
): Promise<ProviderCatalogResult> {
  if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) {
    return null;
  }
  const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
  const {
    headers: _headers,
    auth: explicitAuth,
    apiKey: _apiKey,
    ...explicitWithoutHeaders
  } = explicit ?? {};
  const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderApiKey(PROVIDER_ID);
  let resolvedHeaders: Record<string, string> | undefined;
  let hasAuthorizationHeader: boolean;
  let configuredDiscoveryApiKey: string | undefined;
  try {
    resolvedHeaders = await resolveLmstudioProviderHeaders({
      config: ctx.config,
      env: ctx.env,
      headers: explicit?.headers,
    });
    hasAuthorizationHeader = hasLmstudioAuthorizationHeader(resolvedHeaders);
    configuredDiscoveryApiKey = await resolveLmstudioConfiguredApiKey({
      config: ctx.config,
      env: ctx.env,
      allowUnresolved: hasAuthorizationHeader || Boolean(discoveryApiKey),
    });
  } catch (error) {
    if (error instanceof LmstudioConfigResolutionError) {
      return null;
    }
    throw error;
  }
  const resolvedDiscoveryApiKey = hasAuthorizationHeader
    ? undefined
    : (discoveryApiKey ?? configuredDiscoveryApiKey);
  // CLI/runtime-resolved key takes precedence over static provider config key.
  const resolvedApiKey = apiKey ?? explicit?.apiKey;
  const baseUrl = resolveLmstudioInferenceBase(explicit?.baseUrl);
  const quiet = !apiKey && !explicit && !resolvedDiscoveryApiKey;
  const catalogProfileId =
    !hasAuthorizationHeader && discoveryApiKey && !isNonSecretApiKeyMarker(discoveryApiKey)
      ? profileId
      : undefined;
  const run = async () => {
    let unlistedConfiguredModelIds: string[] = [];
    const models =
      !options && explicit?.models?.length
        ? explicit.models
        : await discoverLmstudioModels({
            onListedModels: (rows) => {
              unlistedConfiguredModelIds = (ctx.configuredModels ?? [])
                .filter((model) => {
                  if (
                    model.provider !== PROVIDER_ID ||
                    (model.baseUrl &&
                      resolveLmstudioServerBase(model.baseUrl) !==
                        resolveLmstudioServerBase(baseUrl))
                  ) {
                    return false;
                  }
                  const modelKey = normalizeLmstudioModelKey(model.modelId);
                  const canonicalKey = resolveLmstudioCanonicalModelKey({ modelKey, models: rows });
                  return !rows.some(
                    (row) =>
                      row.key?.trim() === canonicalKey ||
                      row.loaded_instances?.some((instance) => instance?.id?.trim() === modelKey),
                  );
                })
                .map((model) => model.modelId);
            },
            baseUrl,
            apiKey: resolvedDiscoveryApiKey ?? "",
            headers: resolvedHeaders,
            quiet,
            ...(!quiet && options ? options : {}),
          });
    if (models.length === 0 && (options ? quiet : !apiKey && !explicit?.apiKey)) {
      return null;
    }
    const persistedApiKey = resolvePersistedLmstudioApiKey({
      currentApiKey: resolvedApiKey,
      explicitAuth,
      fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      hasModels: models.length > 0,
      hasAuthorizationHeader,
    });
    const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
    return {
      ...(unlistedConfiguredModelIds.length
        ? {
            outcomes: [
              {
                provider: PROVIDER_ID,
                profileId: catalogProfileId,
                status: "ready" as const,
                unlistedConfiguredModelIds,
              },
            ],
          }
        : {}),
      provider: {
        ...explicitWithoutHeaders,
        baseUrl,
        api: explicit?.api ?? "openai-completions",
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
        ...(persistedAuth ? { auth: persistedAuth } : {}),
        models,
      },
    };
  };
  return options
    ? await runLiveProviderCatalog({
        providerId: PROVIDER_ID,
        profileId: catalogProfileId,
        run,
      })
    : await run();
}
