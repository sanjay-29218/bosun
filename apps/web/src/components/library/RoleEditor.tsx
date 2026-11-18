import { useAtomValue } from "@effect/atom-react";
import {
  FEATURE_MANAGER_ROLE_ID,
  type RoleConfig,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
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
import { EditorField } from "../settings/CrewAgentFields";
import { SettingsModelPicker } from "../settings/SettingsModelPicker";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InstructionsEditor } from "../InstructionsEditor";
import { toastManager } from "../ui/toast";
import { LibraryMachines, ManagedFromNotice } from "./LibraryMachines";

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

/** A role's or bot's model, reasoning and speed, in the composer's picker. */
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
    <SettingsModelPicker
      environmentId={environmentId}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      triggerAriaLabel="Model"
      {...(disabled ? { disabled } : {})}
      onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
        onChange(
          instanceId === selection.instanceId && model === selection.model
            ? selection
            : createModelSelection(instanceId, model),
        )
      }
      traits={{
        options: selection.options,
        onChange: (options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options)),
      }}
    />
  );
}

/** The environment's default model, which new roles and bots start from. */
export function useEnvironmentDefaultModel(environmentId: EnvironmentId) {
  const { settings, providers } = useModelPickerData(environmentId, null);
  return resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
}

/** Adds the Feature manager, Planner, Designer, Builder, QA Tester and Reviewer when missing. */
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
  roles.some((role) => role.id === FEATURE_MANAGER_ROLE_ID);

type RoleChange = Partial<Pick<RoleConfig, "name" | "instructions" | "modelSelection" | "enabled">>;

export function useSaveRole(environmentId: EnvironmentId) {
  const update = useAtomCommand(rolesEnvironment.update);
  return async (role: RoleConfig, change: RoleChange) => {
    const next = { ...role, ...change };
    const result = await update({
      environmentId,
      input: {
        id: role.id,
        name: next.name,
        instructions: next.instructions,
        modelSelection: next.modelSelection,
        enabled: next.enabled,
        expectedRevision: role.revision,
      },
    });
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: `Could not save ${role.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };
}

/** A role's instructions and model; `role` null adds one. Every role gets every tool. */
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
  const managedFrom = role?.managedFrom ?? null;
  const permitted = useAtomValue(
    (role ? rolesEnvironment.update : rolesEnvironment.create).permissionAtom(environmentId),
  );
  const canEdit = permitted && managedFrom === null;
  const [name, setName] = useState(role?.name ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const [modelSelection, setModelSelection] = useState(role?.modelSelection ?? defaultModel);
  const [saving, setSaving] = useState(false);
  const fields = {
    name: name.trim(),
    instructions: instructions.trim(),
    modelSelection,
  };
  const edited = role
    ? fields.name !== role.name ||
      fields.instructions !== role.instructions ||
      JSON.stringify(fields.modelSelection) !== JSON.stringify(role.modelSelection)
    : fields.name.length > 0 || fields.instructions.length > 0;
  const canSave =
    edited && canEdit && fields.name.length > 0 && fields.instructions.length > 0 && !saving;

  useUnsavedChangesGuard({ unsaved: edited, saving, message: "Leave without saving this role?" });

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const savedId = await (async () => {
      if (role) return (await save(role, fields)) ? role.id : null;
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
      {managedFrom === null ? null : <ManagedFromNotice noun="role" owner={managedFrom} />}
      <fieldset disabled={saving || !canEdit} className="min-w-0 space-y-6">
        <SettingsSection title="Role" hideTitle>
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
            description="Model, reasoning and speed for this role's threads. They get every tool, with full access."
            control={
              <RoleModelPicker
                environmentId={environmentId}
                selection={modelSelection}
                disabled={saving || !canEdit}
                onChange={setModelSelection}
              />
            }
          />
        </SettingsSection>
        {role !== null && managedFrom === null ? (
          <LibraryMachines environmentId={environmentId} item={role} />
        ) : null}
      </fieldset>
      {/* Pinned to the pane's bottom, so Save stays in reach below long instructions. */}
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
