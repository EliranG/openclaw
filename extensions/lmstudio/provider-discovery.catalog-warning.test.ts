import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import lmstudioProviderDiscovery from "./provider-discovery.js";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "warns only from a successful LM Studio inventory (offline=%s)",
  async (offline) => {
    const fetchMock = vi.fn(async () => {
      if (offline) {
        throw new Error("server offline");
      }
      return Response.json({
        models: [
          {
            type: "llm",
            key: "google/gemma-local",
            selected_variant: "gemma-q4",
            variants: ["gemma-q8"],
            loaded_instances: [{ id: "local-instance" }],
          },
          { type: "embedding", key: "embed-local" },
        ],
      });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const ctx: ProviderCatalogContext = {
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://127.0.0.1:1234/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      configuredModels: [
        ...[
          "google/gemma-local",
          "lmstudio/google/gemma-local",
          "GEMMA-Q4",
          "gemma-q8",
          "local-instance",
          "embed-local",
          "gemma-typo",
        ].map((modelId) => ({ provider: "lmstudio", modelId })),
        { provider: "lmstudio", modelId: "other-server", baseUrl: "http://other-server:1234/v1" },
      ],
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await lmstudioProviderDiscovery.catalog.run(ctx);
    expect(result?.outcomes).toEqual([
      offline
        ? { provider: "lmstudio", status: "unavailable" }
        : { provider: "lmstudio", status: "ready", unlistedConfiguredModelIds: ["gemma-typo"] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
