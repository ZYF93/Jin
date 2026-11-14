# Provider 与模型

Jin 通过五种协议调用语言模型，全部在 **设置 → Provider** 里配置。

## 支持的协议

| 类型 | 端点 | 认证 | 说明 |
| --- | --- | --- | --- |
| **OpenAI 兼容** | `<base>/chat/completions` | `Authorization: Bearer` | 默认；适配多数 OpenAI 兼容网关与 Ollama |
| **OpenAI Responses** | `<base>/responses` | `Authorization: Bearer` | 更新的 Responses API；推理强度映射到 `reasoning.effort` |
| **Anthropic** | `<base>/v1/messages` | `x-api-key` + `anthropic-version` | base URL 可以带也可以不带末尾 `/v1` |
| **Google Gemini** | `<base>/v1beta/models/<模型>:generateContent` | `x-goog-api-key` | 思考强度映射到 `thinkingConfig.thinkingBudget` |
| **Ollama** | `<base>/chat/completions` | 无（或本地） | 本地 OpenAI 兼容服务 |

**实现引擎（Eko）** 说 OpenAI 协议，Jin 会自动把 Anthropic 和 Gemini 路由到它们各自的 OpenAI 兼容层，因此每种协议在规划与实现阶段都能用。

## 自定义请求头

很多网关/代理需要标准 bearer 之外的额外鉴权或路由头。在设置里逐行填 `请求头: 值`，会合并覆盖协议默认头，随每次请求发送。

## 可选网页搜索端点

给 agent 提供 `web_search` 工具，需配置一个 JSON 搜索端点（兼容 Brave / Tavily / SearXNG）及其密钥。未配置时，agent 退回到用 `fetch_url` 访问已知 URL。

## 模型预设（2026 阵容）

选中模型时，若 Provider 没有上报上下文窗口/价格/视觉能力，Jin 会用内置预设表自动带出。预设覆盖当前主流系列：

- **OpenAI** — `gpt-6.1-*` / `gpt-6-*`（Sol/Terra/Luna）、`gpt-5.6`、`gpt-5.x`、`gpt-4.x`、`o3` / `o4-mini`
- **Anthropic** — `claude-fable-5.2`、`claude-opus/sonnet/haiku-5.5`、`claude-*-4`
- **Google** — `gemini-4`、`gemini-3.8/3.7/3.5`、`gemini-2.5-*`
- **DeepSeek** — `deepseek-v4.1-flash`（视觉）、`deepseek-v4` / `v4-flash`、`deepseek-v3.2`
- **GLM** — `glm-5.3`（FlashX/Flash 变体）、`glm-5`、`glm-4.x`
- **Kimi** — `kimi-k3.1`、`kimi-k3`、`kimi-k2.7-code`
- **Qwen** — `qwen3.8`、`qwen3.7`、`qwen3-coder`
- **本地** — `llama`、`mistral`、`gemma`、`phi`（仅上下文）

匹配用**最长前缀**，所以带日期快照的 id（如 `gpt-6.1-terra-20261026`）仍能解析到所属系列。若 Provider 返回的模型预设表里没有，Jin 优先用远端元数据，缺价格/视觉时留空。

### 推理强度

每个 Provider 设一次。协议支持时会被转发（`reasoning_effort`、`reasoning.effort`，或 Gemini/Anthropic 的思考预算），不支持则忽略；`auto` 什么都不发。

## 尚未支持

- Provider 账号的 OAuth 登录（自带密钥即可）。
- Bedrock / Vertex / Azure 的原生 SDK 鉴权——用它们的 OpenAI 兼容端点。
- 向规划阶段流式传图；图片附加在实现阶段（仅视觉模型可用）。
