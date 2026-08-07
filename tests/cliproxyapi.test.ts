import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RegisteredProvider {
  id: string;
  stream: unknown;
  streamSimple: unknown;
  getModels(): Array<{ id: string; api: string; baseUrl: string }>;
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
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "gemini-2.5-pro" },
                { id: "gpt-image-1" },
                { id: "gpt-5.6-sol" },
                { id: "claude-opus-5" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

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
});
