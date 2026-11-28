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
import { resolveProjectSettings, type LegacyProjectSettingsFields } from "./projectSettings.ts";
import {
  modelFallbackNotice,
  noRunnableModelText,
  resolveNewThreadModelSelection,
} from "./usageLimits.ts";

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

/**
 * The default model for new work: the project's or Settings' saved default, else the automatic
 * one. Null when no provider can run. Without a project, the server-wide default. Whether it can
 * run right now is `resolveNewThreadModelSelection`'s call.
 */
export function resolveDefaultModelSelection(
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ModelSelection | null {
  const resolved = resolveProjectSettings(settings, projectId, project).settings;
  return (
    resolved.defaultModelSelection ?? resolveAutomaticModelSelection(providers, resolved, projectId)
  );
}

/**
 * The model one agent run uses: `chosen`, else the default, switched to `roleFallback` or the
 * Settings fallback model while that one can't run here, by `resolveNewThreadModelSelection`'s
 * rule. `notice` says so; `blocked` says why none can run. Null when no provider can run at all.
 */
export function resolveRunModelSelection(input: {
  readonly chosen: ModelSelection | null;
  readonly roleFallback?: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | null;
  readonly project?: LegacyProjectSettingsFields | null;
  readonly now: number;
}): {
  readonly selection: ModelSelection;
  readonly notice: { readonly title: string; readonly message: string } | null;
  readonly blocked: string | null;
} | null {
  const { providers, settings, projectId, now } = input;
  const selection =
    input.chosen ?? resolveDefaultModelSelection(providers, settings, projectId, input.project);
  if (selection === null) return null;
  const rule = {
    fallbackSelection: resolveProjectSettings(settings, projectId, input.project).settings
      .fallbackModelSelection,
    roleFallbackSelection: input.roleFallback ?? null,
    providers,
    now,
    settings,
    projectId,
  };
  const resolved = resolveNewThreadModelSelection({ ...rule, defaultSelection: selection });
  return {
    selection: resolved.selection ?? selection,
    notice:
      resolved.fallback && resolved.selection
        ? modelFallbackNotice(
            { selection: resolved.selection, fallback: resolved.fallback },
            providers,
          )
        : null,
    blocked: resolved.blocked
      ? noRunnableModelText({ ...rule, selection, blocked: resolved.blocked })
      : null,
  };
}
