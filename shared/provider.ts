import type { ProviderSettings } from "./ipc";

/** The minimum provider shape needed to decide whether Jin can call a model. */
export type ProviderIdentity = Pick<
  ProviderSettings,
  "kind" | "baseUrl" | "model"
>;

/**
 * A provider is configured only when the user has supplied both an endpoint
 * and a model. API keys stay optional because local OpenAI-compatible servers
 * often accept anonymous requests.
 */
export function isProviderConfigured(provider: ProviderIdentity | null | undefined): boolean {
  if (!provider || provider.kind === "none") return false;
  return Boolean(provider.baseUrl.trim() && provider.model.trim());
}
