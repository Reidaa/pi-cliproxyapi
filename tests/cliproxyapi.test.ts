import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RegisteredProvider {
  id: string;
  stream: unknown;
  streamSimple: unknown;
  getModels(): Array<{
    id: string;
    api: string;
    baseUrl: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number };
  }>;
}

/** Routes the proxy and the models.dev request of a single test run. */
function stubFetch(models: string[], modelsDev: unknown) {
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) => {
    const body = String(url).includes("models.dev")
      ? modelsDev
      : { data: models.map((id) => ({ id })) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/**
 * Loads the extension with a clean module registry (model discovery runs at
 * load time) and returns the provider it registered.
 */
async function loadProvider(): Promise<RegisteredProvider> {
  vi.resetModules();
  const { default: loadExtension } = await import("../extensions/cliproxyapi.ts");
  let provider: RegisteredProvider | undefined;
  await loadExtension({
    registerProvider(value: unknown) {
      provider = value as RegisteredProvider;
    },
  } as never);
  if (!provider) throw new Error("Extension did not register a provider");
  return provider;
}

describe("cliproxyapi extension", () => {
  let agentDir: string;

  beforeEach(async () => {
    // An isolated agent dir keeps the test from reading real stored credentials.
    agentDir = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-test-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("CLI_PROXY_API_BASE_URL", undefined);
    vi.stubEnv("CLI_PROXY_API_API_KEY", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(agentDir, { recursive: true, force: true });
  });

  it("loads without configuration and registers streaming methods", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Model discovery should not run without configuration");
      }),
    );

    const provider = await loadProvider();

    expect(provider.id).toBe("cliproxyapi");
    expect(provider.stream).toBeTypeOf("function");
    expect(provider.streamSimple).toBeTypeOf("function");
    expect(provider.getModels()).toEqual([]);
  });

  it("routes discovered models through the supported proxy APIs", async () => {
    vi.stubEnv("CLI_PROXY_API_BASE_URL", "https://proxy.example.com:8317");
    vi.stubEnv("CLI_PROXY_API_API_KEY", "test-key");
    stubFetch(["gemini-2.5-pro", "gpt-image-1", "gpt-5.6-sol", "claude-opus-5"], {});

    const provider = await loadProvider();

    expect(provider.getModels().map(({ id, api, baseUrl }) => ({ id, api, baseUrl }))).toEqual([
      {
        id: "claude-opus-5",
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com:8317",
      },
      {
        id: "gemini-2.5-pro",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com:8317/v1",
      },
      {
        id: "gpt-5.6-sol",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com:8317/v1",
      },
    ]);
  });

  it("takes metadata from models.dev for ids pi does not know", async () => {
    vi.stubEnv("CLI_PROXY_API_BASE_URL", "https://proxy.example.com:8317");
    vi.stubEnv("CLI_PROXY_API_API_KEY", "test-key");
    stubFetch(["moonshotai/kimi-k3", "codex-auto-review"], {
      moonshotai: {
        models: {
          "kimi-k3": {
            name: "Kimi K3",
            reasoning: true,
            modalities: { input: ["text", "image"] },
            cost: { input: 3, output: 15 },
            limit: { context: 1_048_576, output: 131_072 },
          },
        },
      },
    });

    const models = await loadProvider().then((provider) => provider.getModels());

    expect(models[1]).toMatchObject({
      id: "moonshotai/kimi-k3",
      name: "Kimi K3",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com:8317/v1",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 3 },
    });
    // Proxy-internal ids are on no catalog and keep the conservative fallback.
    expect(models[0]).toMatchObject({
      id: "codex-auto-review",
      name: "codex-auto-review (CLI Proxy API)",
      contextWindow: 200_000,
    });
  });
});
