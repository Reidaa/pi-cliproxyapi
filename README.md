# pi-cliapiproxy

A pi package with one extension. The extension registers the `cliapiproxy`
provider. The provider connects pi to a CLI API Proxy instance.

## What the extension does

- Reads the model list from `<baseUrl>/models` at startup and on refresh.
- Routes `claude-*` models to the `anthropic-messages` API and all other
  models to the `openai-responses` API.
- Takes model metadata (context window, output limit, price, thinking levels)
  from the pi catalogs for OpenAI and Anthropic. Unknown ids get conservative
  defaults.
- Excludes `gpt-image-*` models, because pi cannot use them as chat models.
- Adds no default model. If discovery fails, the provider offers no models.

## Install

```bash
pi install /home/thomas/workspace/pi-cliapiproxy
# or, after you push it to a remote:
pi install git:github.com/<user>/pi-cliapiproxy
```

## Configure

Run the login flow and give the base URL and the API key:

```
/login cliapiproxy
```

Or set the environment variables:

- `CLI_API_PROXY_BASE_URL` — for example `https://proxy.example.com:8317/v1`
- `CLI_API_PROXY_API_KEY`

The extension adds `/v1` to the base URL if it is not there. The Anthropic SDK
adds `/v1` by itself, so the extension removes it for Anthropic models.

## Model availability

Control which models the proxy serves in the proxy configuration
(`oauth-excluded-models` in `config.yaml`). The extension does not filter for
availability.

## Files

- `extensions/cliapiproxy-models.ts` — the provider extension
