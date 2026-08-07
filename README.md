# pi-cliproxyapi

A pi package with one extension. The extension registers the `cliproxyapi`
provider. The provider connects pi to a CLI Proxy API instance.

## What the extension does

- Reads the model list from `<baseUrl>/models` at startup and on refresh.
- Routes `claude-*` models to the `anthropic-messages` API and all other
  models to the `openai-responses` API.
- Takes model metadata (context window, output limit, price, thinking levels)
  from the pi catalogs for OpenAI and Anthropic. For ids that are not in those
  catalogs it reads the metadata from [models.dev](https://models.dev). Ids
  that neither source knows get conservative defaults.
- Excludes `gpt-image-*` models, because pi cannot use them as chat models.
- Adds no default model. If discovery fails, the provider offers no models.

## Install

```bash
pi install /path/to/pi-cliproxyapi
# or, after you push it to a remote:
pi install git:github.com/<user>/pi-cliproxyapi
```

The package supports pi `0.83.x` and `0.84.x`. Restart pi after installing or
updating the extension so the previous extension runtime is not reused.

## Configure

Run the login flow and give the base URL and the API key:

```
/login cliproxyapi
```

Or set the environment variables:

- `CLI_PROXY_API_BASE_URL` — for example `https://proxy.example.com:8317/v1`
- `CLI_PROXY_API_KEY`

The extension adds `/v1` to the base URL if it is not there. The Anthropic SDK
adds `/v1` by itself, so the extension removes it for Anthropic models.

## Model availability

Control which models the proxy serves in the proxy configuration
(`oauth-excluded-models` in `config.yaml`). The extension does not filter for
availability.

## Model metadata

Metadata is resolved in this order:

1. The pi builtin catalogs for OpenAI and Anthropic. They also carry the
   thinking levels, so they stay authoritative.
2. The models.dev catalog, for everything else the proxy serves (DeepSeek,
   Kimi, Qwen and others).
3. A conservative fallback (200k context, 32k output, zero cost) for ids that
   are on no catalog, such as proxy-internal models.

The models.dev catalog is downloaded only when the discovered list contains an
id the pi catalogs do not know. It is cached in
`<agent dir>/cliproxyapi-models-dev.json` for 24 hours. If the download fails,
the extension uses the stale cache, and the fallback if there is no cache.

The same id is listed by many providers on models.dev with different prices
and limits. The vendor that publishes the model wins over resellers; the
provider order is in `src/models-dev.ts`.

models.dev carries no API protocol and no thinking levels, so the routing of
`claude-*` models to `anthropic-messages` stays in the extension.

## Development

```bash
npm run check        # format check, lint, types and tests
npm test             # vitest
npm run lint         # oxlint
npm run format       # oxfmt, writes in place
npm run typecheck    # tsc --noEmit
```

## Files

- `extensions/cliproxyapi.ts` — the provider extension
- `src/models-dev.ts` — the models.dev metadata catalog with disk cache
- `tests/` — vitest tests for the extension and the catalog
- `.oxlintrc.json`, `.oxfmtrc.json` — oxlint and oxfmt configuration
