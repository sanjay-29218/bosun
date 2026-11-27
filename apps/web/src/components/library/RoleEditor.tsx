import { useAtomValue } from "@effect/atom-react";
import {
  PLANNER_ROLE_ID,
  type RoleConfig,
  type EnvironmentId,
  type LibraryPushTarget,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { modelDisplayName } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import { m } from "../../i18n/messages";
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
import { EditorField } from "../settings/EditorField";
import { SettingsModelPicker } from "../settings/SettingsModelPicker";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InstructionsEditor } from "../InstructionsEditor";
import { toastManager } from "../ui/toast";
import { AlsoUpdateOnDialog, LibraryImportBanner, LibraryImportedOn } from "./LibraryImport";

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
  ariaLabel,
  triggerLabel,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  /** Shown instead of the model, for a picker with nothing chosen yet. */
  readonly triggerLabel?: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const gt = useGT();
  const { entries, modelOptions } = useModelPickerData(environmentId, selection);
  return (
    <SettingsModelPicker
      environmentId={environmentId}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={modelOptions}
      triggerAriaLabel={ariaLabel ?? gt("Model")}
      {...(triggerLabel === undefined ? {} : { triggerLabel })}
      {...(disabled ? { disabled } : {})}
      onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
        onChange(
          instanceId === selection.instanceId && model === selection.model
            ? selection
            : createModelSelection(instanceId, model),
        )
      }
      traits={
        triggerLabel === undefined
          ? {
              options: selection.options,
              onChange: (options) =>
                onChange(createModelSelection(selection.instanceId, selection.model, options)),
            }
          : null
      }
    />
  );
}

/** The environment's default model, which new roles and bots start from. */
export function useEnvironmentDefaultModel(environmentId: EnvironmentId) {
  const { settings, providers } = useModelPickerData(environmentId, null);
  return resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
}

/** Adds the Planner, Designer, Builder, QA Tester and Reviewer when missing. */
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
        title: m(msg("Could not add the starter roles")),
        description: formatEnvironmentQueryError(result.cause),
      });
      return false;
    },
  };
}

export const hasStarterRoles = (roles: ReadonlyArray<RoleConfig>) =>
  roles.some((role) => role.id === PLANNER_ROLE_ID);

type RoleChange = Partial<
  Pick<
    RoleConfig,
    "name" | "instructions" | "modelSelection" | "fallbackModelSelection" | "enabled"
  >
>;

export function useSaveRole(environmentId: EnvironmentId) {
  const update = useAtomCommand(rolesEnvironment.update);
  return async (
    role: RoleConfig,
    change: RoleChange,
    alsoUpdateOn: ReadonlyArray<LibraryPushTarget> = [],
  ) => {
    const next = { ...role, ...change };
    const result = await update({
      environmentId,
      input: {
        id: role.id,
        name: next.name,
        instructions: next.instructions,
        modelSelection: next.modelSelection,
        fallbackModelSelection: next.fallbackModelSelection,
        enabled: next.enabled,
        expectedRevision: role.revision,
        ...(alsoUpdateOn.length > 0 ? { alsoUpdateOn: [...alsoUpdateOn] } : {}),
      },
    });
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: m(msg("Could not save {name}", { name: role.name })),
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
  const gt = useGT();
  const create = useAtomCommand(rolesEnvironment.create);
  const save = useSaveRole(environmentId);
  const canEdit = useAtomValue(
    (role ? rolesEnvironment.update : rolesEnvironment.create).permissionAtom(environmentId),
  );
  const [name, setName] = useState(role?.name ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const [modelSelection, setModelSelection] = useState(role?.modelSelection ?? defaultModel);
  const [fallbackModelSelection, setFallbackModelSelection] = useState(
    role?.fallbackModelSelection ?? null,
  );
  const [saving, setSaving] = useState(false);
  // Saving one that linked machines imported asks which of them take the change.
  const [asking, setAsking] = useState(false);
  const fields = {
    name: name.trim(),
    instructions: instructions.trim(),
    modelSelection,
    fallbackModelSelection,
  };
  const edited = role
    ? fields.name !== role.name ||
      fields.instructions !== role.instructions ||
      JSON.stringify(fields.modelSelection) !== JSON.stringify(role.modelSelection) ||
      JSON.stringify(fields.fallbackModelSelection) !== JSON.stringify(role.fallbackModelSelection)
    : fields.name.length > 0 || fields.instructions.length > 0;
  const canSave =
    edited && canEdit && fields.name.length > 0 && fields.instructions.length > 0 && !saving;

  useUnsavedChangesGuard({
    unsaved: edited,
    saving,
    message: gt("Leave without saving this role?"),
  });

  const submit = async (alsoUpdateOn?: ReadonlyArray<LibraryPushTarget>) => {
    if (!canSave) return;
    if (role && role.importers.length > 0 && alsoUpdateOn === undefined) {
      setAsking(true);
      return;
    }
    setAsking(false);
    setSaving(true);
    const savedId = await (async () => {
      if (role) return (await save(role, fields, alsoUpdateOn)) ? role.id : null;
      const id = `role:${randomUUID()}`;
      const result = await create({ environmentId, input: { id, ...fields } });
      if (result._tag === "Success") return id;
      toastManager.add({
        type: "error",
        title: m(msg("Could not add the role")),
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
      {role === null ? null : (
        <LibraryImportBanner
          environmentId={environmentId}
          kind="role"
          item={role}
          unsaved={edited}
        />
      )}
      <fieldset disabled={saving || !canEdit} className="min-w-0 space-y-6">
        <SettingsSection
          title={gt("Role", { $context: "section heading for a role's name and instructions" })}
          hideTitle
        >
          <div className="space-y-5 px-3 py-4 sm:px-4">
            <EditorField label={gt("Name")} htmlFor="crew-role-name">
              <Input
                id="crew-role-name"
                value={name}
                maxLength={200}
                placeholder={gt("Security reviewer")}
                onChange={(event) => setName(event.target.value)}
              />
            </EditorField>
            <EditorField label={gt("Instructions")} htmlFor="crew-role-instructions">
              <InstructionsEditor
                id="crew-role-instructions"
                label={gt("Instructions")}
                value={instructions}
                maxLength={16_000}
                size="lg"
                disabled={saving || !canEdit}
                placeholder={gt("What this role does and how it reports back")}
                onChange={setInstructions}
              />
            </EditorField>
          </div>
        </SettingsSection>
        <SettingsSection
          title={gt("Runs with", { $context: "section heading: the models a role runs with" })}
        >
          <SettingsRow
            title={gt("Model")}
            description={gt(
              "Model, reasoning and speed for this role's threads. They get every tool, with full access.",
            )}
            control={
              <RoleModelPicker
                environmentId={environmentId}
                selection={modelSelection}
                disabled={saving || !canEdit}
                onChange={setModelSelection}
              />
            }
          />
          <FallbackModelRow
            environmentId={environmentId}
            selection={fallbackModelSelection}
            roleModel={modelSelection}
            disabled={saving || !canEdit}
            onChange={setFallbackModelSelection}
          />
        </SettingsSection>
        {role === null ? null : <LibraryImportedOn item={role} />}
      </fieldset>
      {role === null ? null : (
        <AlsoUpdateOnDialog
          name={role.name}
          importers={role.importers}
          open={asking}
          onCancel={() => setAsking(false)}
          onSave={(alsoUpdateOn) => void submit(alsoUpdateOn)}
        />
      )}
      {/* Pinned to the pane's bottom, so Save stays in reach below long instructions. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 bg-background/95 px-1 py-3 backdrop-blur-sm">
        <Button
          type="button"
          variant="ghost-muted"
          size="sm"
          disabled={saving || (role !== null && !edited)}
          onClick={onCancel}
        >
          {role ? gt("Discard", { $context: "verb, discards unsaved edits" }) : gt("Cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!canSave}>
          {role ? gt("Save role") : gt("Add role")}
        </Button>
      </div>
    </form>
  );
}

/**
 * A role's own fallback model, tried before the one in Settings when the role's model can't run
 * here. Unset, the row names the Settings one it falls back to.
 */
function FallbackModelRow({
  environmentId,
  selection,
  roleModel,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly roleModel: ModelSelection;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  const gt = useGT();
  const { settings, providers } = useModelPickerData(environmentId, selection);
  const global = settings.fallbackModelSelection;
  const settingsLink = (
    <Link to="/settings/threads" className="underline underline-offset-2">
      <T>Settings → Threads</T>
    </Link>
  );
  const notHere =
    selection !== null &&
    !providers.some((provider) => provider.instanceId === selection.instanceId);
  const status = notHere ? (
    <span className="text-warning-foreground">
      <T>Not set up on this machine. Uses the Settings fallback instead.</T>
    </span>
  ) : selection !== null ? null : global === null ? (
    <T>
      <Var>{settingsLink}</Var> has no fallback model either.
    </T>
  ) : (
    <T>
      Uses the fallback model in <Var>{settingsLink}</Var>:{" "}
      <Var>{modelDisplayName(global, providers)}</Var>.
    </T>
  );
  return (
    <SettingsRow
      title={gt("Fallback model")}
      description={gt(
        "Used when this role's model can't run here, such as when its provider is out of usage.",
      )}
      status={status}
      resetAction={
        selection === null ? null : (
          <SettingResetButton
            ariaLabel={gt("Use the Settings fallback")}
            tooltip={gt("Use the Settings fallback")}
            disabled={disabled}
            onClick={() => onChange(null)}
          />
        )
      }
      control={
        <RoleModelPicker
          environmentId={environmentId}
          selection={selection ?? global ?? roleModel}
          disabled={disabled}
          ariaLabel={gt("Fallback model")}
          {...(selection === null ? { triggerLabel: gt("Settings fallback") } : {})}
          onChange={onChange}
        />
      }
    />
  );
}
