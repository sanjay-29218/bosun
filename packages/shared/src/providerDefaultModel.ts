import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

/** The model a provider instance starts on: its default model, else its first. */
export function defaultProviderModel(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider.driver]
  );
}

/**
 * The model new threads in a project start on when nobody saved a default: the project's first
 * usable provider in picker order (each driver's default instance first, then its custom ones),
 * preferring the first driver, on that provider's default model. Null when none can run.
 */
export function resolveAutomaticModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
): ModelSelection | null {
  const byDriver = new Map<ProviderDriverKind, ServerProvider[]>();
  for (const provider of providers) {
    const bucket = byDriver.get(provider.driver) ?? [];
    bucket.push(provider);
    byDriver.set(provider.driver, bucket);
  }
  const ordered = [...byDriver].flatMap(([driver, bucket]) => {
    const defaultId = defaultInstanceIdForDriver(driver);
    return [
      ...bucket.filter((provider) => provider.instanceId === defaultId),
      ...bucket.filter((provider) => provider.instanceId !== defaultId),
    ];
  });
  const selectable = (provider: ServerProvider) =>
    resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId) &&
    provider.availability !== "unavailable";
  const pick = (candidates: ReadonlyArray<ServerProvider>) =>
    candidates.find((provider) => selectable(provider) && provider.status === "ready") ??
    candidates.find((provider) => selectable(provider) && provider.status !== "error");
  const provider =
    pick(ordered.filter((candidate) => candidate.driver === ordered[0]?.driver)) ?? pick(ordered);
  const model = provider ? defaultProviderModel(provider) : undefined;
  return provider && model ? { instanceId: provider.instanceId, model } : null;
}
