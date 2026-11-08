import type {
  ProviderModel,
  ProviderModelCatalog,
  ProviderModelRequest,
  ReasoningEffort,
} from "../../../shared/ipc";

const ALL_EFFORTS: ReasoningEffort[] = ["auto", "low", "medium", "high"];
const FETCH_TIMEOUT_MS = 12_000;
const OLLAMA_PROBE_TIMEOUT_MS = 5_000;
const OLLAMA_PROBE_LIMIT = 24;
const OLLAMA_PROBE_CONCURRENCY = 4;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Common model families that accept a reasoning-effort control. */
const REASONING_MODEL =
  /(^|[/:])(o1|o3|o4)(-|$)|gpt-5|gpt-oss|deepseek-(r1|reasoner)|qwq|qwen3|magistral|grok-(3|4).*reason|claude.*(thinking|opus-4|sonnet-4)|gemini-2\.5|kimi-k2-thinking|glm-4\.5|phi-4-reasoning/i;

const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  auto: "auto",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
  maximum: "high",
};

export class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    value = Number(value.trim());
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return undefined;
}

function normalizeEfforts(value: unknown): ReasoningEffort[] | null {
  if (!Array.isArray(value)) return null;
  const efforts = new Set<ReasoningEffort>();
  for (const item of value) {
    const raw =
      typeof item === "string"
        ? item
        : isRecord(item)
          ? stringValue(item.effort) ||
            stringValue(item.level) ||
            stringValue(item.name) ||
            stringValue(item.id)
          : "";
    const effort = EFFORT_ALIASES[raw.toLowerCase()];
    if (effort) efforts.add(effort);
  }
  if (efforts.size === 0) return null;
  efforts.add("auto");
  return ALL_EFFORTS.filter((effort) => efforts.has(effort));
}

function effortListKey(key: string): boolean {
  return (
    /^(supported_)?reasoning_?(efforts?|levels?)$/i.test(key) ||
    /^(supported_)?efforts?$/i.test(key) ||
    /^levels$/i.test(key)
  );
}

/**
 * Walk capability metadata for an explicit effort list. Providers expose
 * these under different names, e.g. OpenRouter's `supported_parameters` and
 * native `capabilities.reasoning.efforts` objects.
 */
function readEffortsFrom(value: unknown, depth = 0): ReasoningEffort[] | null {
  if (!isRecord(value) || depth > 3) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (!effortListKey(key)) continue;
    const efforts = normalizeEfforts(entry);
    if (efforts) return efforts;
  }
  for (const key of ["capabilities", "reasoning", "thinking", "features", "metadata", "meta"]) {
    const nested = readEffortsFrom(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function supportedParameterEfforts(value: unknown): ReasoningEffort[] | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase());
  return names.some((name) => /reasoning[_-]?effort|(^|_)reasoning($|_)|thinking/.test(name))
    ? ALL_EFFORTS
    : null;
}

function capabilityReasoning(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.some(
      (item) => typeof item === "string" && /^(reasoning|thinking|reasoning_effort)$/i.test(item),
    );
  }
  if (isRecord(value)) {
    for (const key of [
      "reasoning",
      "thinking",
      "reasoning_effort",
      "supports_reasoning",
      "supportsReasoning",
      "supported",
    ]) {
      if (typeof value[key] === "boolean") return value[key] as boolean;
    }
  }
  return null;
}

export interface ReasoningResolution {
  efforts: ReasoningEffort[];
  source: "remote" | "inferred" | "default";
}

/**
 * Resolve effort options for one model. Remote metadata wins; otherwise known
 * reasoning families get the full range. Unknown models keep the full range
 * too, because OpenAI-compatible servers frequently accept the field without
 * advertising it, and the provider request retries without it on a 400.
 */
export function resolveReasoningEfforts(
  id: string,
  raw: Record<string, unknown> = {},
): ReasoningResolution {
  const explicit =
    readEffortsFrom(raw) ??
    supportedParameterEfforts(raw.supported_parameters) ??
    supportedParameterEfforts(raw.supportedParameters);
  if (explicit) return { efforts: explicit, source: "remote" };

  const capability =
    capabilityReasoning(raw.capabilities) ??
    capabilityReasoning(raw.features) ??
    capabilityReasoning(raw.reasoning) ??
    capabilityReasoning(raw.supports_reasoning) ??
    capabilityReasoning(raw.supportsReasoning) ??
    capabilityReasoning(raw.thinking);
  if (capability === false) return { efforts: ["auto"], source: "remote" };
  if (capability === true) return { efforts: ALL_EFFORTS, source: "remote" };
  if (REASONING_MODEL.test(id)) {
    return { efforts: ALL_EFFORTS, source: "inferred" };
  }
  return { efforts: ALL_EFFORTS, source: "default" };
}

/** Backwards-compatible helper used by tests and callers that only need ids. */
export function reasoningEffortsForModel(
  id: string,
  raw: Record<string, unknown> = {},
): ReasoningEffort[] {
  return resolveReasoningEfforts(id, raw).efforts;
}

function contextFromModelInfo(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!/\.(context_length|context_window|n_ctx_train)$/i.test(key)) continue;
    const direct = numberValue(entry);
    if (direct) return direct;
    if (isRecord(entry)) {
      const nested =
        numberValue(entry.context_length) ??
        numberValue(entry.context_window) ??
        numberValue(entry.n_ctx_train);
      if (nested) return nested;
    }
  }
  return undefined;
}

function contextWindowForModel(raw: Record<string, unknown>): number | undefined {
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const meta = isRecord(raw.meta) ? raw.meta : {};
  return (
    numberValue(limit.context) ??
    numberValue(raw.context_window) ??
    numberValue(raw.contextWindow) ??
    numberValue(raw.context_length) ??
    numberValue(raw.contextLength) ??
    numberValue(raw.max_context_length) ??
    numberValue(raw.maxContextLength) ??
    numberValue(raw.max_model_len) ??
    numberValue(raw.maxModelLen) ??
    numberValue(raw.n_ctx_train) ??
    numberValue(raw.n_ctx) ??
    numberValue(meta.n_ctx_train) ??
    numberValue(meta.context_length) ??
    numberValue(isRecord(raw.details) ? raw.details.context_length : undefined) ??
    contextFromModelInfo(raw.model_info)
  );
}

function normalizeOpenAIModel(item: unknown): ProviderModel | null {
  if (typeof item === "string") {
    const id = item.trim();
    if (!id) return null;
    const resolution = resolveReasoningEfforts(id);
    return {
      id,
      name: id,
      reasoningEfforts: resolution.efforts,
      reasoningSource: resolution.source,
    };
  }
  if (!isRecord(item)) return null;
  const id = stringValue(item.id) || stringValue(item.model) || stringValue(item.name);
  if (!id) return null;
  const resolution = resolveReasoningEfforts(id, item);
  const contextWindow = contextWindowForModel(item);
  return {
    id,
    name: stringValue(item.name) || stringValue(item.display_name) || id,
    reasoningEfforts: resolution.efforts,
    reasoningSource: resolution.source,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** Parse OpenAI-compatible `/models` responses, including a bare id array. */
export function parseOpenAIModelPayload(payload: unknown): ProviderModel[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const models = list
    .map(normalizeOpenAIModel)
    .filter((model): model is ProviderModel => model !== null);
  return dedupe(models);
}

/** Parse Ollama `/api/tags` responses. */
export function parseOllamaModelPayload(payload: unknown): ProviderModel[] {
  const list =
    isRecord(payload) && Array.isArray(payload.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models = list
    .map((item): ProviderModel | null => {
      if (!isRecord(item)) return null;
      const id = stringValue(item.name) || stringValue(item.model);
      if (!id) return null;
      const resolution = resolveReasoningEfforts(id, item);
      const contextWindow = contextWindowForModel(item);
      return {
        id,
        name: stringValue(item.name) || id,
        reasoningEfforts: resolution.efforts,
        reasoningSource: resolution.source,
        ...(contextWindow ? { contextWindow } : {}),
      };
    })
    .filter((model): model is ProviderModel => model !== null);
  return dedupe(models);
}

function dedupe(models: ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) byId.set(model.id, model);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ModelCatalogError("The provider base URL must start with http:// or https://.");
  }
  return trimmed;
}

/** Candidate endpoints in the order they should be tried. */
export function modelEndpointCandidates(
  kind: ProviderModelRequest["kind"],
  baseUrl: string,
): string[] {
  const base = cleanBaseUrl(baseUrl);
  if (kind === "none") return [];
  if (kind === "ollama") {
    if (/\/api\/tags$/i.test(base)) return [base];
    const root = base.replace(/\/(api|v1)$/i, "");
    return [`${root}/api/tags`];
  }
  const apiRoot = base.replace(/\/chat\/completions$/i, "");
  if (/\/models$/i.test(apiRoot)) return [apiRoot];
  if (/\/v\d+$/i.test(apiRoot)) return [`${apiRoot}/models`];
  return [`${apiRoot}/models`, `${apiRoot}/v1/models`];
}

function ollamaShowEndpoint(baseUrl: string): string {
  const base = cleanBaseUrl(baseUrl);
  const root = base
    .replace(/\/api\/tags$/i, "")
    .replace(/\/api$/i, "")
    .replace(/\/v1$/i, "");
  return `${root}/api/show`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ModelCatalogError("The provider model list is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelCatalogError("The provider returned a non-JSON model list.");
  }
}

async function requestCatalog(
  url: string,
  apiKey: string | null,
): Promise<{ payload: unknown; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 404) return { payload: null, status: 404 };
      throw new ModelCatalogError(
        `Provider ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    return { payload: await readJson(response), status: response.status };
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelCatalogError("The provider model list timed out.");
    }
    throw new ModelCatalogError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one Ollama model's capabilities and context length. */
async function probeOllamaModel(
  endpoint: string,
  model: string,
  apiKey: string | null,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await readJson(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ollamaCapabilityEfforts(payload: unknown): ReasoningEffort[] | null {
  if (!isRecord(payload)) return null;
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  if (
    capabilities.some((item) => /thinking|reasoning/i.test(item)) ||
    capabilityReasoning(payload.capabilities) === true
  ) {
    return ALL_EFFORTS;
  }
  return null;
}

/**
 * Ollama's `/api/tags` only lists names. `/api/show` is the remote capability
 * source for thinking support and context length, so enrich a bounded batch
 * in parallel and keep the tag data when a probe fails.
 */
async function enrichOllamaModels(
  baseUrl: string,
  models: ProviderModel[],
  apiKey: string | null,
): Promise<ProviderModel[]> {
  if (models.length === 0) return models;
  const endpoint = ollamaShowEndpoint(baseUrl);
  const targets = models.slice(0, OLLAMA_PROBE_LIMIT);
  const enriched = new Map<string, ProviderModel>();
  for (let index = 0; index < targets.length; index += OLLAMA_PROBE_CONCURRENCY) {
    const batch = targets.slice(index, index + OLLAMA_PROBE_CONCURRENCY);
    const payloads = await Promise.all(
      batch.map((model) => probeOllamaModel(endpoint, model.id, apiKey)),
    );
    batch.forEach((model, offset) => {
      const payload = payloads[offset];
      if (!payload) return;
      const efforts = ollamaCapabilityEfforts(payload);
      const contextWindow = isRecord(payload)
        ? (contextFromModelInfo(payload.model_info) ?? contextWindowForModel(payload))
        : undefined;
      enriched.set(model.id, {
        ...model,
        ...(efforts ? { reasoningEfforts: efforts, reasoningSource: "remote" as const } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      });
    });
  }
  return models.map((model) => enriched.get(model.id) ?? model);
}

/**
 * Fetch model ids and any capability hints the provider exposes. The request
 * may include a not-yet-saved API key so the settings dialog can populate the
 * list before the user presses Save.
 */
export async function fetchModelCatalog(
  request: ProviderModelRequest,
): Promise<ProviderModelCatalog> {
  const candidates = modelEndpointCandidates(request.kind, request.baseUrl);
  if (candidates.length === 0) {
    throw new ModelCatalogError("Choose a provider before fetching models.");
  }
  let payload: unknown = null;
  let lastStatus = 0;
  for (const url of candidates) {
    const result = await requestCatalog(url, request.apiKey ?? null);
    lastStatus = result.status;
    if (result.status !== 404) {
      payload = result.payload;
      break;
    }
  }
  if (payload === null) {
    throw new ModelCatalogError(
      lastStatus === 404
        ? "The provider does not expose a model list at this base URL."
        : "The provider returned no model list.",
    );
  }
  let models =
    request.kind === "ollama" ? parseOllamaModelPayload(payload) : parseOpenAIModelPayload(payload);
  if (request.kind === "ollama") {
    models = await enrichOllamaModels(request.baseUrl, models, request.apiKey ?? null);
  }
  return {
    provider: request.kind,
    models,
    fetchedAt: new Date().toISOString(),
    ...(models.length === 0 ? { warning: "The provider returned no models." } : {}),
  };
}
