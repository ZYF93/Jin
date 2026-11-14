# Providers & models

Jin talks to language models through five wire protocols, all configurable in **Settings → Provider**.

## Supported protocols

| Kind | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| **OpenAI-compatible** | `<base>/chat/completions` | `Authorization: Bearer` | Default; works with most OpenAI-compatible gateways and Ollama |
| **OpenAI Responses** | `<base>/responses` | `Authorization: Bearer` | The newer Responses API; reasoning effort maps to `reasoning.effort` |
| **Anthropic** | `<base>/v1/messages` | `x-api-key` + `anthropic-version` | Base URL may or may not already end in `/v1` |
| **Google Gemini** | `<base>/v1beta/models/<model>:generateContent` | `x-goog-api-key` | Thinking effort maps to `thinkingConfig.thinkingBudget` |
| **Ollama** | `<base>/chat/completions` | none (or local) | Local OpenAI-compatible server |

For the **implementation engine** (Eko), which speaks the OpenAI protocol, Jin automatically routes Anthropic and Gemini through their OpenAI-compatible layers, so every protocol works for both planning and implementation.

## Custom request headers

Many gateways and proxies need extra auth or routing headers that are not the standard bearer key. Add them in Settings (one `header: value` per line); they are merged over the protocol defaults and sent with every request.

## Optional web-search endpoint

To give the agent a `web_search` tool, set a JSON search endpoint (Brave / Tavily / SearXNG are understood) and its key. Without one, the agent falls back to `fetch_url` for known URLs.

## Model presets (2026 lineup)

When you pick a model, Jin fills in its context window, per-million-token price, and vision flag from a built-in preset table when the provider does not advertise them. Presets cover the current major families:

- **OpenAI** — `gpt-6.1-*` / `gpt-6-*` (Sol/Terra/Luna), `gpt-5.6`, `gpt-5.x`, `gpt-4.x`, `o3` / `o4-mini`
- **Anthropic** — `claude-fable-5.2`, `claude-opus/sonnet/haiku-5.5`, `claude-*-4`
- **Google** — `gemini-4`, `gemini-3.8/3.7/3.5`, `gemini-2.5-*`
- **DeepSeek** — `deepseek-v4.1-flash` (vision), `deepseek-v4` / `v4-flash`, `deepseek-v3.2`
- **GLM** — `glm-5.3` (FlashX/Flash variants), `glm-5`, `glm-4.x`
- **Kimi** — `kimi-k3.1`, `kimi-k3`, `kimi-k2.7-code`
- **Qwen** — `qwen3.8`, `qwen3.7`, `qwen3-coder`
- **Local** — `llama`, `mistral`, `gemma`, `phi` (context only)

Matching is by **longest prefix**, so a dated snapshot id like `gpt-6.1-terra-20261026` still resolves to its family entry. If a provider returns a model the preset table does not know, Jin uses the remote metadata when present and leaves price/vision blank otherwise.

### Reasoning effort

Set once per provider. It is forwarded where the protocol supports it (`reasoning_effort`, `reasoning.effort`, or a Gemini/Anthropic thinking budget) and otherwise ignored. `auto` sends nothing.

## What is not supported (yet)

- OAuth login for provider accounts (bring your own key).
- Bedrock / Vertex / Azure native SDK auth — use their OpenAI-compatible endpoints instead.
- Streaming image input to the planner; images are attached to the implementation turn (vision models only).
