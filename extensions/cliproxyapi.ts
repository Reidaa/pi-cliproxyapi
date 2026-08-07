import { createProvider, type Api, type ApiKeyCredential, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cliproxyapi";
const BASE_URL_ENV = "CLI_PROXY_API_BASE_URL";
const API_KEY_ENV = "CLI_PROXY_API_API_KEY";
const MODEL_TIMEOUT_MS = 10_000;

/**
 * The proxy speaks the native Anthropic and OpenAI Responses protocols, so
 * models are routed to the matching API rather than flattened onto
 * openai-completions. Metadata (context window, output limit, pricing,
 * thinking levels) is taken from pi's own catalogs instead of guessed from
 * the id, because /v1/models returns ids only.
 */
const CATALOG: Record<string, Model<Api>> = Object.fromEntries(
  [...getBuiltinModels("openai"), ...getBuiltinModels("anthropic")].map((model) => [
    model.id,
    model,
  ]),
);

/**
 * Models the proxy serves but pi cannot use as chat models. Availability
 * filtering belongs to the proxy (`oauth-excluded-models` in config.yaml), so
 * this list stays limited to capability mismatches.
 */
const isExcluded = (id: string) => id.startsWith("gpt-image-");

interface RemoteModel {
  id?: unknown;
}

interface RemoteModelList {
  data?: RemoteModel[];
}

/**
 * Fallback for an id absent from pi's catalogs. Conservative on purpose: a
 * too-large context window causes hard request failures, a too-small one only
 * compacts early.
 */
function unknownModel(id: string): Model<Api> {
  const anthropic = id.startsWith("claude-");
  return {
    id,
    name: `${id} (CLI Proxy API)`,
    api: anthropic ? "anthropic-messages" : "openai-responses",
    provider: PROVIDER_ID,
    baseUrl: "",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  } as Model<Api>;
}

/**
 * The Anthropic SDK appends /v1 itself, so it needs the origin; the OpenAI
 * Responses API is called at the /v1 root.
 */
function modelFor(id: string, baseUrl: string): Model<Api> {
  const base = CATALOG[id] ?? unknownModel(id);
  const anthropic = base.api === "anthropic-messages";
  return {
    ...base,
    id,
    provider: PROVIDER_ID,
    baseUrl: anthropic ? baseUrl.replace(/\/v1$/, "") : baseUrl,
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("CLI Proxy API base URL is required");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function configuredBaseUrl(credential?: ApiKeyCredential): string | undefined {
  const value = credential?.env?.[BASE_URL_ENV] ?? process.env[BASE_URL_ENV];
  return typeof value === "string" && value.trim() ? normalizeBaseUrl(value) : undefined;
}

function configuredApiKey(credential?: ApiKeyCredential): string | undefined {
  const value = credential?.key ?? process.env[API_KEY_ENV];
  return typeof value === "string" && value ? value : undefined;
}

async function fetchModels(
  baseUrl: string,
  apiKey: string,
  parentSignal?: AbortSignal,
): Promise<Model<Api>[]> {
  const timeoutSignal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!response.ok) {
    throw new Error(`CLI Proxy API model discovery failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as RemoteModelList;
  if (!Array.isArray(payload.data)) {
    throw new Error("CLI Proxy API returned an invalid model list");
  }

  const ids = payload.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => !isExcluded(id));

  const uniqueIds = [...new Set(ids)].toSorted((a, b) => a.localeCompare(b));
  if (uniqueIds.length === 0) {
    throw new Error("CLI Proxy API returned no compatible chat models");
  }

  return uniqueIds.map((id) => modelFor(id, baseUrl));
}

export default async function (pi: ExtensionAPI) {
  const stored = readStoredCredential(PROVIDER_ID);
  const startupCredential = stored?.type === "api_key" ? stored : undefined;
  const startupBaseUrl = configuredBaseUrl(startupCredential);
  const startupApiKey = configuredApiKey(startupCredential);
  // No hardcoded default model: the proxy decides what it serves. If discovery
  // fails the provider offers nothing, which is honest — an id invented here
  // would fail at request time anyway, and pi falls back to another provider.
  let startupModels: Model<Api>[] = [];

  if (startupBaseUrl && startupApiKey) {
    try {
      startupModels = await fetchModels(startupBaseUrl, startupApiKey);
    } catch (error) {
      console.warn(
        `[${PROVIDER_ID}] Model discovery failed (is the proxy reachable?): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  pi.registerProvider(
    createProvider({
      id: PROVIDER_ID,
      name: "CLI Proxy API",
      baseUrl: startupBaseUrl,
      auth: {
        apiKey: {
          name: "CLI Proxy API",
          async login(interaction) {
            const current = readStoredCredential(PROVIDER_ID);
            const currentCredential = current?.type === "api_key" ? current : undefined;
            const enteredBaseUrl = await interaction.prompt({
              type: "text",
              message: "CLI Proxy API base URL",
              placeholder:
                configuredBaseUrl(currentCredential) ?? "https://proxy.example.com:8317/v1",
            });
            const baseUrl = normalizeBaseUrl(
              enteredBaseUrl || configuredBaseUrl(currentCredential) || "",
            );
            const apiKey =
              (await interaction.prompt({ type: "secret", message: "CLI Proxy API key" })).trim() ||
              configuredApiKey(currentCredential);
            if (!apiKey) throw new Error("CLI Proxy API key is required");

            interaction.notify({
              type: "progress",
              message: "Checking endpoint and loading models...",
            });
            await fetchModels(baseUrl, apiKey, interaction.signal);
            return { type: "api_key", key: apiKey, env: { [BASE_URL_ENV]: baseUrl } };
          },
          async check({ ctx, credential }) {
            const baseUrlValue = credential?.env?.[BASE_URL_ENV] ?? (await ctx.env(BASE_URL_ENV));
            const apiKey = credential?.key ?? (await ctx.env(API_KEY_ENV));
            if (!baseUrlValue || !apiKey) return undefined;
            return {
              type: "api_key",
              source: credential
                ? "stored CLI Proxy API settings"
                : `${BASE_URL_ENV} and ${API_KEY_ENV}`,
            };
          },
          async resolve({ ctx, credential }) {
            const baseUrlValue = credential?.env?.[BASE_URL_ENV] ?? (await ctx.env(BASE_URL_ENV));
            const apiKey = credential?.key ?? (await ctx.env(API_KEY_ENV));
            if (!baseUrlValue || !apiKey) return undefined;
            const baseUrl = normalizeBaseUrl(baseUrlValue);
            return {
              // Per-model baseUrl is already correct, so auth must not override it.
              auth: { apiKey },
              env: { ...credential?.env, [BASE_URL_ENV]: baseUrl },
              source: credential
                ? "stored CLI Proxy API settings"
                : `${BASE_URL_ENV} and ${API_KEY_ENV}`,
            };
          },
        },
      },
      models: startupModels,
      async fetchModels(context) {
        if (context.credential?.type !== "api_key") {
          throw new Error("CLI Proxy API settings are not configured");
        }
        const baseUrl = configuredBaseUrl(context.credential);
        const apiKey = configuredApiKey(context.credential);
        if (!baseUrl || !apiKey) {
          throw new Error(`Run /login ${PROVIDER_ID} or set ${BASE_URL_ENV} and ${API_KEY_ENV}`);
        }
        return fetchModels(baseUrl, apiKey, context.signal);
      },
      api: {
        "anthropic-messages": anthropicMessagesApi(),
        "openai-responses": openAIResponsesApi(),
      },
    }),
  );
}
