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
import {
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardTabs } from "../ui/wizard";
import { Dialog, DialogClose } from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { CrewLimitsSettings } from "./CrewLimitsSettings";
import { CrewToolPicker, crewToolLabel, EditorField } from "./CrewAgentFields";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { CrewEnvironmentNotice, useCrewSettingsEnvironment } from "./crewSettingsEnvironment";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The composer's provider and model choices for one environment. */
function useModelPickerData(environmentId: EnvironmentId, selection: ModelSelection | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
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

/** Roles workflow stages run as, then the limits on running agents. Both are environment-wide. */
export function RolesSettings() {
  const { environment, supported } = useCrewSettingsEnvironment("crew");
  return (
    <SettingsPageContainer>
      {environment && supported ? (
        <RolesSection key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        <SettingsSection title="Roles" id={searchableSetting("roles").id}>
          <CrewEnvironmentNotice
            connected={environment !== null}
            supported={supported}
            noun="roles"
          />
        </SettingsSection>
      )}
      <CrewLimitsSettings />
    </SettingsPageContainer>
  );
}

/** The environment's default model, which new roles and bots start from. */
export function useEnvironmentDefaultModel(environmentId: EnvironmentId) {
  const { settings, providers } = useModelPickerData(environmentId, null);
  return resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
}

function RolesSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  const rolesQuery = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const initialize = useAtomCommand(rolesEnvironment.initialize);
  const canEdit = useAtomValue(rolesEnvironment.update.permissionAtom(environmentId));
  const [editor, setEditor] = useState<{ role: RoleConfig | null } | null>(null);
  const [initializing, setInitializing] = useState(false);
  const roles = rolesQuery.data ?? [];
  const hasRoles = roles.some((role) => role.id === PROJECT_MANAGER_ROLE_ID);

  const addStarterRoles = async () => {
    if (!defaultModel) return;
    setInitializing(true);
    try {
      const result = await initialize({
        environmentId,
        input: { modelSelection: defaultModel },
      });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not add the starter roles",
          description: formatEnvironmentQueryError(result.cause),
        });
      }
    } finally {
      setInitializing(false);
    }
  };

  return (
    <SettingsSection
      title="Roles"
      id={searchableSetting("roles").id}
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!defaultModel || !rolesQuery.data || !canEdit}
          onClick={() => setEditor({ role: null })}
        >
          <PlusIcon className="size-3" />
          Add role
        </Button>
      }
    >
      {rolesQuery.error ? (
        <SettingsRow title="Could not load roles" description={rolesQuery.error} />
      ) : !rolesQuery.data ? (
        <SettingsRow title="Loading roles…" role="status" />
      ) : (
        <>
          {!hasRoles ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No roles yet</EmptyTitle>
                <EmptyDescription>
                  Add the starter roles: a Project manager, Planner, Designer, Builder, QA Tester
                  and Reviewer. You can change each one afterwards.
                </EmptyDescription>
              </EmptyHeader>
              <Button
                size="sm"
                disabled={!defaultModel || initializing || !canEdit}
                onClick={() => void addStarterRoles()}
              >
                Add the starter roles
              </Button>
            </Empty>
          ) : null}
          {roles.map((role) => (
            <RoleRow
              key={role.id}
              environmentId={environmentId}
              role={role}
              disabled={!canEdit}
              onEdit={() => setEditor({ role })}
            />
          ))}
        </>
      )}
      {editor && defaultModel ? (
        <RoleDialog
          environmentId={environmentId}
          role={editor.role}
          defaultModel={defaultModel}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

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

function RoleRow({
  environmentId,
  role,
  disabled,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig;
  readonly disabled: boolean;
  readonly onEdit: () => void;
}) {
  const save = useSaveRole(environmentId);
  const [busy, setBusy] = useState(false);
  const locked = busy || disabled;
  const run = async (change: RoleChange) => {
    setBusy(true);
    try {
      await save(role, change);
    } finally {
      setBusy(false);
    }
  };
  const summary = role.instructions.split("\n")[0]?.trim() ?? "";
  const status = [
    // The project manager joins workflows as the project's own manager, not as a stage role.
    !role.autoCreateForFeature && role.id !== PROJECT_MANAGER_ROLE_ID
      ? "Not available to workflow stages"
      : null,
    role.allowedTools.length > 0
      ? `Tools: ${role.allowedTools.map(crewToolLabel).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingsRow
      aria-disabled={!role.enabled || undefined}
      title={
        <span className="flex items-center gap-1.5">
          {role.name}
          {!role.enabled ? (
            <Badge size="sm" variant="outline">
              Off
            </Badge>
          ) : null}
        </span>
      }
      description={summary.length > 160 ? `${summary.slice(0, 157)}…` : summary}
      status={status || undefined}
      control={
        <>
          <RoleModelPicker
            environmentId={environmentId}
            selection={role.modelSelection}
            disabled={locked}
            onChange={(modelSelection) => void run({ modelSelection })}
          />
          <RuntimeModeSelect
            label={`When ${role.name} acts`}
            value={role.runtimeMode}
            disabled={locked}
            size="sm"
            onChange={(mode) => void run({ runtimeMode: mode })}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={locked}
                  aria-label={`Actions for ${role.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem onClick={() => void run({ enabled: !role.enabled })}>
                <PowerIcon />
                {role.enabled ? "Turn off" : "Turn on"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    />
  );
}

function RoleDialog({
  environmentId,
  role,
  defaultModel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig | null;
  readonly defaultModel: ModelSelection;
  readonly onClose: () => void;
}) {
  const create = useAtomCommand(rolesEnvironment.create);
  const save = useSaveRole(environmentId);
  const [name, setName] = useState(role?.name ?? "");
  const [instructions, setInstructions] = useState(role?.instructions ?? "");
  const [tools, setTools] = useState<ReadonlyArray<string>>(role?.allowedTools ?? []);
  const [modelSelection, setModelSelection] = useState(role?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    role?.runtimeMode ?? "auto-accept-edits",
  );
  // Stages pick roles directly, so a role a person adds is available to workflows by default.
  const [workflowStages, setWorkflowStages] = useState(role?.autoCreateForFeature ?? true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"behavior" | "tools">("behavior");
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        instructions: instructions.trim(),
        allowedTools: tools,
        modelSelection,
        runtimeMode,
        autoCreateForFeature: workflowStages,
      };
      if (role) {
        if (await save(role, fields)) onClose();
        return;
      }
      const result = await create({
        environmentId,
        input: { id: `role:${randomUUID()}`, ...fields },
      });
      if (result._tag === "Success") onClose();
      else
        toastManager.add({
          type: "error",
          title: "Could not add the role",
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={role ? `Edit ${role.name}` : "Add role"}
          description="A role is what a workflow stage runs as: its instructions, tools and default model."
        >
          <WizardTabs
            label="Role settings"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "behavior", label: "Behavior", icon: <SlidersHorizontalIcon /> },
              { value: "tools", label: `Tools · ${tools.length}`, icon: <WrenchIcon /> },
            ]}
          />
        </WizardHeader>
        {/* One height for both tabs, so switching doesn't resize the dialog. */}
        <WizardPanel className="min-h-[30rem]">
          <fieldset disabled={saving} className="space-y-5">
            <EditorField label="Name" htmlFor="crew-role-name">
              <Input
                id="crew-role-name"
                value={name}
                maxLength={200}
                placeholder="Security reviewer"
                onChange={(event) => setName(event.target.value)}
              />
            </EditorField>
            {tab === "behavior" ? (
              <>
                <EditorField label="Instructions" htmlFor="crew-role-instructions">
                  <Textarea
                    id="crew-role-instructions"
                    value={instructions}
                    maxLength={16_000}
                    rows={6}
                    placeholder="What this role does and how it reports back"
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </EditorField>
                <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <EditorField label="Model">
                    <div>
                      <RoleModelPicker
                        environmentId={environmentId}
                        selection={modelSelection}
                        onChange={setModelSelection}
                      />
                    </div>
                  </EditorField>
                  <EditorField label="Access">
                    <RuntimeModeSelect
                      label="Access"
                      value={runtimeMode}
                      onChange={setRuntimeMode}
                    />
                  </EditorField>
                  <EditorField label="Workflow stages" htmlFor="crew-role-workflow-stages">
                    <div className="flex h-9 items-center">
                      <Switch
                        id="crew-role-workflow-stages"
                        aria-label="Workflow stages can use this role"
                        checked={workflowStages}
                        onCheckedChange={setWorkflowStages}
                      />
                    </div>
                  </EditorField>
                </div>
              </>
            ) : (
              <EditorField label="Tools">
                <CrewToolPicker value={tools} onChange={setTools} />
              </EditorField>
            )}
          </fieldset>
        </WizardPanel>
        <WizardFooter>
          <DialogClose render={<Button variant="ghost-muted" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {role ? "Save role" : "Add role"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
