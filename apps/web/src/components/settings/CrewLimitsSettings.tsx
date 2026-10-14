import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type CrewSettings, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DEFAULT_CREW = DEFAULT_SERVER_SETTINGS.crew;

/** The patch for one provider's cap. The map is replaced whole, so a removed cap stays removed. */
export function providerLimitsPatch(
  current: CrewSettings["providerLimits"],
  instanceId: string,
  limit: number | null,
): CrewSettings["providerLimits"] {
  const next = { ...current };
  if (limit === null) delete next[instanceId as keyof typeof next];
  else next[instanceId as keyof typeof next] = limit;
  return next;
}

/** A whole number within bounds; empty means "not set" where `allowEmpty`. */
export function LimitField({
  label,
  value,
  min,
  max,
  placeholder,
  allowEmpty = false,
  onCommit,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly placeholder?: string;
  readonly allowEmpty?: boolean;
  readonly onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }
  return (
    <NumberField
      value={draft}
      min={min}
      max={max}
      step={1}
      size="sm"
      className="w-32"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          if (allowEmpty && value !== null) onCommit(null);
          else setDraft(value);
          return;
        }
        const bounded = Math.min(max, Math.max(min, Math.round(next)));
        setDraft(bounded);
        if (bounded !== value) onCommit(bounded);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput aria-label={label} placeholder={placeholder} />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * Environment-wide limits on stage threads. At a project selection the rows
 * show the inherited values and go read-only, like other environment settings.
 */
export function CrewLimitsSettings() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  // Caps are keyed by provider instance, which is per machine, and a patch replaces the whole
  // map. Editing them for several environments at once would overwrite each one's caps.
  const capsEnvironment =
    scope.kind === "environment" || (scope.kind === "all" && connectedEnvironments.length === 1)
      ? target
      : null;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["crew"]);
  const crew = settings.crew;
  const update = (patch: Partial<CrewSettings>) => updateSettings({ crew: patch });
  const mixedStatus = mixed ? "Mixed across selected environments" : undefined;

  return (
    <SettingsSection title="Limits" id={searchableSetting("role-limits").id}>
      <SettingsRow
        serverScoped
        settingKeys={["crew"]}
        title="Agents running at once"
        description="Stage threads beyond this wait as Queued. Threads you start yourself don't count."
        status={mixedStatus}
        resetAction={
          crew.maxRunningStageThreads !== DEFAULT_CREW.maxRunningStageThreads ? (
            <SettingResetButton
              label="agents running at once"
              onClick={() =>
                update({ maxRunningStageThreads: DEFAULT_CREW.maxRunningStageThreads })
              }
            />
          ) : null
        }
        control={
          <LimitField
            label="Agents running at once"
            value={crew.maxRunningStageThreads}
            min={1}
            max={64}
            onCommit={(value) => {
              if (value !== null) update({ maxRunningStageThreads: value });
            }}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["crew"]}
        title="Per provider"
        description="Stops one provider's rate limit from stalling every feature. Empty means no cap."
        resetAction={
          Object.keys(crew.providerLimits).length > 0 ? (
            <SettingResetButton
              label="per-provider limits"
              onClick={() => update({ providerLimits: {} })}
            />
          ) : null
        }
      >
        {capsEnvironment ? (
          <ProviderLimitRows
            environmentId={capsEnvironment.environmentId}
            limits={crew.providerLimits}
            onChange={(providerLimits) => update({ providerLimits })}
          />
        ) : (
          <p className="pb-2 text-xs text-muted-foreground">
            Caps are set per environment. Choose one environment above to change them.
          </p>
        )}
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["crew"]}
        title="Retries before a stage fails"
        description="Default for workflows that don't set their own."
        status={mixedStatus}
        resetAction={
          crew.stageRetries !== DEFAULT_CREW.stageRetries ? (
            <SettingResetButton
              label="retries"
              onClick={() => update({ stageRetries: DEFAULT_CREW.stageRetries })}
            />
          ) : null
        }
        control={
          <LimitField
            label="Retries before a stage fails"
            value={crew.stageRetries}
            min={0}
            max={10}
            onCommit={(value) => {
              if (value !== null) update({ stageRetries: value });
            }}
          />
        }
      />
    </SettingsSection>
  );
}

/** One cap per provider instance set up on the representative environment. */
function ProviderLimitRows({
  environmentId,
  limits,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly limits: CrewSettings["providerLimits"];
  readonly onChange: (limits: CrewSettings["providerLimits"]) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instances = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers),
    settings,
    null,
  ).filter((entry) => entry.enabled || limits[entry.instanceId] !== undefined);
  if (instances.length === 0) {
    return <p className="pb-2 text-xs text-muted-foreground">No providers set up.</p>;
  }
  return (
    <div className="divide-y divide-border/60 pb-1">
      {instances.map((entry) => (
        <div key={entry.instanceId} className="flex items-center justify-between gap-4 py-2">
          <span className="min-w-0 truncate text-sm">{entry.displayName}</span>
          <LimitField
            label={`${entry.displayName} limit`}
            value={limits[entry.instanceId] ?? null}
            min={1}
            max={64}
            placeholder="–"
            allowEmpty
            onCommit={(value) => onChange(providerLimitsPatch(limits, entry.instanceId, value))}
          />
        </div>
      ))}
    </div>
  );
}
