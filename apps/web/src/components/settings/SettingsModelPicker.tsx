import type {
  ManagedPolicySummary,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "../chat/ComposerModelEffort";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  resolveRuntimeModeOptions,
  runtimeModeConfig,
  runtimeModeOptions,
} from "../chat/runtimeModeConfig";
import type { TraitsSelectionInput } from "../chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * The composer's model picker for a saved model: model, reasoning and speed in one popup, plus
 * access when the saved thing carries its own.
 */
export function SettingsModelPicker({
  traits,
  access,
  ...props
}: Omit<
  ComponentProps<typeof ProviderModelPicker>,
  "effortColumn" | "footer" | "triggerSuffix" | "triggerDetail" | "isComposerOwned"
> & {
  /** Null where the options can't be edited, such as when environments differ. */
  readonly traits: {
    readonly options: ProviderOptions | null | undefined;
    readonly planModeEnabled: boolean;
    readonly onChange: (options: ProviderOptions | undefined) => void;
  } | null;
  readonly access?: {
    readonly runtimeMode: RuntimeMode;
    /** Marks the modes an administrator disallows. */
    readonly managedPolicy?: ManagedPolicySummary | undefined;
    readonly onChange: (mode: RuntimeMode) => void;
  };
}) {
  const effortDisplay = useClientSettings((settings) => settings.effortDisplay);
  const entry = props.instanceEntries.find((item) => item.instanceId === props.activeInstanceId);
  const traitsInput: TraitsSelectionInput | null =
    traits && entry
      ? {
          provider: entry.driverKind,
          instanceId: entry.instanceId,
          models: entry.models,
          model: props.model,
          modelOptions: traits.options ?? [],
          // Ultrathink is a word in a prompt, not a setting a saved model can keep.
          allowPromptInjectedEffort: false,
          planModeEnabled: traits.planModeEnabled,
          onModelOptionsChange: traits.onChange,
        }
      : null;
  const effort = describeComposerEffort(traitsInput, effortDisplay, props.size ?? "sm");
  const accessMode = access ? runtimeModeConfig[access.runtimeMode] : null;
  const AccessIcon = accessMode?.icon;
  const docked = traitsInput !== null || access !== undefined;
  return (
    <ProviderModelPicker
      {...props}
      isComposerOwned={false}
      triggerClassName={cn(
        "group/model-trigger",
        SETTINGS_PICKER_TRIGGER_CLASSNAME,
        props.triggerClassName,
      )}
      triggerSuffix={
        effort.suffix || AccessIcon ? (
          <>
            {effort.suffix}
            {AccessIcon ? (
              <AccessIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </>
        ) : null
      }
      triggerDetail={
        [effort.detail, accessMode?.label].filter((part): part is string => !!part).join(" · ") ||
        null
      }
      {...(docked
        ? {
            effortColumn: <ComposerEffortColumn traits={traitsInput} />,
            footer: (
              <ComposerPickerFooter
                traits={traitsInput}
                {...(access
                  ? {
                      permissions: {
                        runtimeMode: access.runtimeMode,
                        runtimeModeOptions: resolveRuntimeModeOptions(
                          runtimeModeOptions,
                          access.managedPolicy,
                        ),
                        onRuntimeModeChange: access.onChange,
                      },
                    }
                  : {})}
              />
            ),
          }
        : {})}
    />
  );
}
