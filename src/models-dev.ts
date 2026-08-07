import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelCost } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * models.dev is a community catalog of model metadata. The proxy's /v1/models
 * endpoint returns ids only, and pi's builtin catalogs cover just OpenAI and
 * Anthropic, so this fills the gap for everything else the proxy serves
 * (DeepSeek, Kimi, Qwen, ...). Without it those models fall back to a
 * conservative guess: 200k context on a model that holds 1M, and zero cost.
 */
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The same id is listed by many providers with different prices and limits.
 * Vendors that publish their own models come first, so their numbers win over
 * a reseller's. Everything else follows in alphabetical order for determinism.
 */
const PREFERRED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshotai",
  "alibaba",
  "mistral",
  "xai",
  "meta",
  "zhipuai",
];

/** The subset of a pi `Model` that models.dev can supply. */
export interface ModelsDevMetadata {
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

export interface ModelsDevCatalog {
  /** Looks up a proxy model id. Vendor prefixes such as `~deepseek/` are ignored. */
  get(id: string): ModelsDevMetadata | undefined;
  size: number;
}

interface RawEntry {
  name?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

interface CacheFile {
  fetchedAt: number;
  models: Record<string, ModelsDevMetadata>;
}

export const cachePath = join(getAgentDir(), "cliproxyapi-models-dev.json");

/** Proxies prefix ids with a vendor (`moonshotai/kimi-k3`); the tail identifies the model. */
function normalizeId(id: string): string {
  return id.split("/").pop()!.replace(/^~/, "").toLowerCase();
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toMetadata(id: string, entry: RawEntry): ModelsDevMetadata {
  const modalities = Array.isArray(entry.modalities?.input) ? entry.modalities.input : ["text"];
  // pi only understands text and image inputs; video/audio/pdf are dropped.
  const input = (["text", "image"] as const).filter((kind) => modalities.includes(kind));
  return {
    name: typeof entry.name === "string" && entry.name ? entry.name : id,
    reasoning: entry.reasoning === true,
    input: input.length > 0 ? input : ["text"],
    cost: {
      input: num(entry.cost?.input, 0),
      output: num(entry.cost?.output, 0),
      cacheRead: num(entry.cost?.cache_read, 0),
      cacheWrite: num(entry.cost?.cache_write, 0),
    },
    contextWindow: num(entry.limit?.context, 200_000),
    maxTokens: num(entry.limit?.output, 32_000),
  };
}

/** Flattens the per-provider payload into one id → metadata map. */
function index(payload: Record<string, { models?: Record<string, RawEntry> }>) {
  const providers = Object.keys(payload).toSorted((a, b) => {
    const rank = (id: string) => {
      const preferred = PREFERRED_PROVIDERS.indexOf(id);
      return preferred === -1 ? PREFERRED_PROVIDERS.length : preferred;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const models: Record<string, ModelsDevMetadata> = {};
  for (const provider of providers) {
    for (const [id, entry] of Object.entries(payload[provider]?.models ?? {})) {
      const key = normalizeId(id);
      // First writer wins, so the preferred provider's numbers stand.
      models[key] ??= toMetadata(id, entry ?? {});
    }
  }
  return models;
}

async function readCache(): Promise<CacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CacheFile;
    return parsed?.models && typeof parsed.fetchedAt === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(models: Record<string, ModelsDevMetadata>): Promise<void> {
  try {
    await mkdir(join(cachePath, ".."), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now(), models } satisfies CacheFile),
    );
  } catch (error) {
    console.warn(`[cliproxyapi] Could not cache models.dev metadata: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function download(parentSignal?: AbortSignal): Promise<Record<string, ModelsDevMetadata>> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const response = await fetch(MODELS_DEV_URL, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return index((await response.json()) as Record<string, { models?: Record<string, RawEntry> }>);
}

let pending: Promise<ModelsDevCatalog> | undefined;

/**
 * Returns the models.dev catalog, from memory, then the disk cache, then the
 * network. Never throws: a missing catalog only means the caller keeps its own
 * fallback metadata.
 */
export function loadModelsDevCatalog(signal?: AbortSignal): Promise<ModelsDevCatalog> {
  pending ??= resolveCatalog(signal).catch((error) => {
    console.warn(`[cliproxyapi] models.dev metadata unavailable: ${message(error)}`);
    return wrap({});
  });
  return pending;
}

async function resolveCatalog(signal?: AbortSignal): Promise<ModelsDevCatalog> {
  const cached = await readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return wrap(cached.models);

  try {
    const models = await download(signal);
    await writeCache(models);
    return wrap(models);
  } catch (error) {
    console.warn(`[cliproxyapi] models.dev fetch failed: ${message(error)}`);
    // A stale cache is still far better than guessed limits.
    return wrap(cached?.models ?? {});
  }
}

function wrap(models: Record<string, ModelsDevMetadata>): ModelsDevCatalog {
  return {
    get: (id: string) => models[normalizeId(id)],
    size: Object.keys(models).length,
  };
}
