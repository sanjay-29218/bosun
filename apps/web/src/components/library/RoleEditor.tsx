import { useAtomValue } from "@effect/atom-react";
import {
  PROJECT_MANAGER_ROLE_ID,
  type RoleConfig,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useBlocker } from "@tanstack/react-router";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { CrewToolPicker, EditorField } from "../settings/CrewAgentFields";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { InstructionsEditor } from "../InstructionsEditor";
import { toastManager } from "../ui/toast";

/** The composer's provider and model choices for one environment. */
function useModelPickerData(environmentId: EnvironmentId, selection: ModelSelection | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  return { settings, providers, entries, modelOptions };
}

export function RoleModelPicker({
  environmentId,
  selection,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { entries, modelOptions } = useModelPickerData(environmentId, selection);
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      {...(disabled ? { disabled } : {})}
      onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
        onChange(
          instanceId === selection.instanceId && model === selection.model
            ? selection
            : createModelSelection(instanceId, model),
        )
      }
    />
  );
}

/**
 * How freely a role's or bot's threads act: the same access levels, names and descriptions as
 * the composer's, from asking before every change to full access.
 */
export function RuntimeModeSelect({
  value,
  disabled,
  label,
  size,
  onChange,
}: {
  readonly value: RuntimeMode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly size?: "sm";
  readonly onChange: (mode: RuntimeMode) => void;
}) {
  const current = runtimeModeConfig[value];
  return (
    <Select
      value={value}
      {...(disabled ? { disabled } : {})}
      onValueChange={(next) => {
        if (typeof next === "string" && next in runtimeModeConfig) onChange(next as RuntimeMode);
      }}
    >
      <SelectTrigger {...(size ? { size } : {})} aria-label={label}>
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <current.icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{current.label}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {runtimeModeOptions.map((mode) => {
          const option = runtimeModeConfig[mode];
          return (
            <SelectItem key={mode} value={mode}>
              <span className="flex min-w-0 items-start gap-2">
                <option.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

/** The environment's default model, which new roles and bots start from. */
export function useEnvironmentDefaultModel(environmentId: EnvironmentId) {
  const { settings, providers } = useModelPickerData(environmentId, null);
  return resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
}

/** Adds the Project manager, Planner, Designer, Builder, QA Tester and Reviewer when missing. */
export function useAddStarterRoles(environmentId: EnvironmentId) {
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  const initialize = useAtomCommand(rolesEnvironment.initialize);
  return {
    ready: defaultModel !== null,
    add: async () => {
      if (!defaultModel) return false;
      const result = await initialize({ environmentId, input: { modelSelection: defaultModel } });
      if (result._tag === "Success") return true;
      toastManager.add({
        type: "error",
        title: "Could not add the starter roles",
        description: formatEnvironmentQueryError(result.cause),
      });
      return false;
    },
  };
}

export const hasStarterRoles = (roles: ReadonlyArray<RoleConfig>) =>
  roles.some((role) => role.id === PROJECT_MANAGER_ROLE_ID);

type RoleChange = Partial<
  Pick<
    RoleConfig,
    | "name"
    | "instructions"
    | "allowedTools"
    | "modelSelection"
    | "runtimeMode"
    | "enabled"
    | "autoCreateForFeature"
  >
>;

/** Saves a role. A workflow pins role versions, so it has to be republished to pick this up. */
function useSaveRole(environmentId: EnvironmentId) {
  const update = useAtomCommand(rolesEnvironment.update);
  return async (role: RoleConfig, change: RoleChange) => {
    const next = { ...role, ...change };
    const result = await update({
      environmentId,
      input: {
        id: role.id,
        name: next.name,
        instructions: next.instructions,
        allowedTools: [...next.allowedTools],
        modelSelection: next.modelSelection,
        runtimeMode: next.runtimeMode,
        autoCreateForFeature: next.autoCreateForFeature,
        enabled: next.enabled,
        expectedRevision: role.revision,
      },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Could not save ${role.name}`,
        description: formatEnvironmentQueryError(result.cause),
      });
      return false;
    }
    if (next.autoCreateForFeature) {
      toastManager.add({
        type: "info",
        title: `${next.name} saved`,
        description: "Publish the workflows that use this role to start new features with it.",
      });
    }
    return true;
  };
}

/** A role's instructions, tools, model and access; `role` null adds one. */
export function RoleEditorForm({
  environmentId,
  role,
  defaultModel,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig | null;
  readonly defaultModel: ModelSelection;
  readonly onSaved: (roleId: string) => void;
  readonly onCancel: () => void;
}) {
  const create = useAtomCommand(rolesEnvironment.create);
  const save = useSaveRole(environmentId);
  const canEdit = useAtomValue(
    (role ? rolesEnvironment.update : rolesEnvironment.create).permissionAtom(environmentId),
  );
  const [name, setName] = useState(role?.name ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const [tools, setTools] = useState<ReadonlyArray<string>>(role?.allowedTools ?? []);
  const [modelSelection, setModelSelection] = useState(role?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    role?.runtimeMode ?? "auto-accept-edits",
  );
  // Turning a role off retires it. The project manager leads features rather than running
  // stages, so it can't be turned off and never runs as a stage.
  const isProjectManager = role?.id === PROJECT_MANAGER_ROLE_ID;
  const [enabled, setEnabled] = useState(role?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const fields = {
    name: name.trim(),
    instructions: instructions.trim(),
    allowedTools: tools,
    modelSelection,
    runtimeMode,
    autoCreateForFeature: isProjectManager ? (role?.autoCreateForFeature ?? false) : true,
  };
  const edited = role
    ? fields.name !== role.name ||
      fields.instructions !== role.instructions ||
      fields.allowedTools.join("\n") !== role.allowedTools.join("\n") ||
      fields.modelSelection.instanceId !== role.modelSelection.instanceId ||
      fields.modelSelection.model !== role.modelSelection.model ||
      fields.runtimeMode !== role.runtimeMode ||
      fields.autoCreateForFeature !== role.autoCreateForFeature ||
      enabled !== role.enabled
    : fields.name.length > 0 || fields.instructions.length > 0 || tools.length > 0;
  const canSave =
    edited && canEdit && fields.name.length > 0 && fields.instructions.length > 0 && !saving;

  useBlocker({
    shouldBlockFn: async () =>
      edited && !saving && (await requestConfirmDialog("Leave without saving this role?")) !== true,
    enableBeforeUnload: () => edited,
  });

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const savedId = await (async () => {
      if (role) return (await save(role, { ...fields, enabled })) ? role.id : null;
      const id = `role:${randomUUID()}`;
      const result = await create({ environmentId, input: { id, ...fields } });
      if (result._tag === "Success") return id;
      toastManager.add({
        type: "error",
        title: "Could not add the role",
        description: formatEnvironmentQueryError(result.cause),
      });
      return null;
    })();
    // Still saving, so the leave guard lets a new role's navigation through.
    if (savedId !== null) onSaved(savedId);
    setSaving(false);
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={saving || !canEdit} className="min-w-0 space-y-6">
        <SettingsSection title="Role">
          <div className="space-y-5 px-3 py-4 sm:px-4">
            <EditorField label="Name" htmlFor="crew-role-name">
              <Input
                id="crew-role-name"
                value={name}
                maxLength={200}
                placeholder="Security reviewer"
                onChange={(event) => setName(event.target.value)}
              />
            </EditorField>
            <EditorField label="Instructions" htmlFor="crew-role-instructions">
              <InstructionsEditor
                id="crew-role-instructions"
                label="Instructions"
                value={instructions}
                maxLength={16_000}
                size="lg"
                disabled={saving || !canEdit}
                placeholder="What this role does and how it reports back"
                onChange={setInstructions}
              />
            </EditorField>
          </div>
        </SettingsSection>
        <SettingsSection title="Runs with">
          <SettingsRow
            title="Model"
            control={
              <RoleModelPicker
                environmentId={environmentId}
                selection={modelSelection}
                disabled={saving || !canEdit}
                onChange={setModelSelection}
              />
            }
          />
          <SettingsRow
            title="Access"
            control={
              <RuntimeModeSelect
                label="Access"
                value={runtimeMode}
                disabled={saving || !canEdit}
                onChange={setRuntimeMode}
              />
            }
          />
          {role && !isProjectManager ? (
            <SettingsRow
              title="Available in workflows"
              description="Turn off to retire this role. Running features keep it."
              control={
                <Switch
                  aria-label="Workflow stages can use this role"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              }
            />
          ) : null}
        </SettingsSection>
        <SettingsSection title={`Tools · ${tools.length}`}>
          <div className="px-3 py-4 sm:px-4">
            <CrewToolPicker value={tools} onChange={setTools} />
          </div>
        </SettingsSection>
      </fieldset>
      {/* Pinned to the pane's bottom, so Save stays in reach below a long tool list. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 bg-background/95 px-1 py-3 backdrop-blur-sm">
        <Button
          type="button"
          variant="ghost-muted"
          size="sm"
          disabled={saving || (role !== null && !edited)}
          onClick={onCancel}
        >
          {role ? "Discard" : "Cancel"}
        </Button>
        <Button type="submit" size="sm" disabled={!canSave}>
          {role ? "Save role" : "Add role"}
        </Button>
      </div>
    </form>
  );
}
