import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { ollamaProviderDiscovery } from "./provider-discovery.js";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "warns only from a successful Ollama inventory (offline=%s)",
  async (offline) => {
    const fetchMock = vi.fn(async (input: unknown) => {
      if (offline) {
        throw new Error("server offline");
      }
      return Response.json(
        String(input).endsWith("/api/tags")
          ? {
              models: [
                { name: "llama3.2:latest" },
                { name: "qwen3:8b" },
                { name: "nomic-embed-text:latest" },
              ],
            }
          : { capabilities: ["completion"], model_info: {} },
      );
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
    const ctx: ProviderCatalogContext = {
      config: {
        models: {
          providers: { ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] } },
        },
      },
      configuredModels: [
        ...[
          "llama3.2",
          "ollama/llama3.2",
          "LLAMA3.2:latest",
          "qwen3:8b",
          "qwen3:8bb",
          "nomic-embed-text",
        ].map((modelId) => ({ provider: "ollama", modelId })),
        { provider: "ollama", modelId: "other-server", baseUrl: "http://other-server:11434" },
      ],
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await ollamaProviderDiscovery.catalog.run(ctx);
    expect(result?.outcomes).toEqual([
      offline
        ? { provider: "ollama", status: "unavailable" }
        : { provider: "ollama", status: "ready", unlistedConfiguredModelIds: ["qwen3:8bb"] },
    ]);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/tags")),
    ).toHaveLength(1);
  },
);
