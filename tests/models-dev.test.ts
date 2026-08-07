import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LoadCatalog = typeof import("../src/models-dev.ts").loadModelsDevCatalog;

/** Fresh module registry per call, because the catalog is memoized per process. */
async function loadModule(): Promise<{ loadModelsDevCatalog: LoadCatalog; cachePath: string }> {
  vi.resetModules();
  return await import("../src/models-dev.ts");
}

function payload() {
  return {
    // Not a canonical vendor: must lose against `moonshotai` for the same id.
    openrouter: {
      models: {
        "moonshotai/kimi-k3": {
          name: "Kimi K3 (router)",
          cost: { input: 99, output: 99 },
          limit: { context: 1, output: 1 },
        },
      },
    },
    moonshotai: {
      models: {
        "kimi-k3": {
          name: "Kimi K3",
          reasoning: true,
          modalities: { input: ["text", "image", "video"], output: ["text"] },
          cost: { input: 3, output: 15, cache_read: 0.3 },
          limit: { context: 1_048_576, output: 131_072 },
        },
      },
    },
  };
}

function fetchMock(body: unknown, status = 200) {
  return vi.fn<() => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("models.dev catalog", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-modelsdev-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(agentDir, { recursive: true, force: true });
  });

  it("maps entries to pi model metadata and prefers the canonical vendor", async () => {
    const fetch = fetchMock(payload());
    vi.stubGlobal("fetch", fetch);
    const { loadModelsDevCatalog } = await loadModule();

    const catalog = await loadModelsDevCatalog();

    expect(catalog.get("moonshotai/kimi-k3")).toEqual({
      name: "Kimi K3",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("matches a prefixed proxy id by its last path segment", async () => {
    vi.stubGlobal("fetch", fetchMock(payload()));
    const { loadModelsDevCatalog } = await loadModule();

    const catalog = await loadModelsDevCatalog();

    expect(catalog.get("~moonshot/kimi-k3")?.contextWindow).toBe(1_048_576);
    expect(catalog.get("unknown-model")).toBeUndefined();
  });

  it("serves a fresh disk cache without hitting the network", async () => {
    const fetch = fetchMock(payload());
    vi.stubGlobal("fetch", fetch);
    const first = await loadModule();
    await first.loadModelsDevCatalog();
    expect(JSON.parse(await readFile(first.cachePath, "utf8")).models["kimi-k3"]).toBeDefined();

    const second = await loadModule();
    const catalog = await second.loadModelsDevCatalog();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(catalog.get("kimi-k3")?.name).toBe("Kimi K3");
  });

  it("falls back to a stale cache when the fetch fails", async () => {
    const { cachePath } = await loadModule();
    await writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: 0,
        models: { "kimi-k3": { name: "Stale K3", contextWindow: 42, maxTokens: 7 } },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("offline");
      }),
    );
    const { loadModelsDevCatalog } = await loadModule();

    const catalog = await loadModelsDevCatalog();

    expect(catalog.get("kimi-k3")?.name).toBe("Stale K3");
  });

  it("returns an empty catalog when there is neither network nor cache", async () => {
    vi.stubGlobal("fetch", fetchMock("nope", 500));
    const { loadModelsDevCatalog } = await loadModule();

    expect((await loadModelsDevCatalog()).size).toBe(0);
  });
});
