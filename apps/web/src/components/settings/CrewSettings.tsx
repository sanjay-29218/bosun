import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type BotTemplateConfig,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { MoreHorizontalIcon, PencilIcon, PlusIcon, PowerIcon, UsersIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { botsEnvironment } from "../../state/bots";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { CrewLimitsSettings } from "./CrewLimitsSettings";
import { parseList } from "./WorkflowEditor.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type RoleMode = "act" | "ask";

/** "Ask first" is approval-required; any other runtime mode acts on its own. */
export function roleMode(runtimeMode: RuntimeMode): RoleMode {
  return runtimeMode === "approval-required" ? "ask" : "act";
}

function runtimeModeFor(mode: RoleMode, current: RuntimeMode): RuntimeMode {
  if (mode === "ask") return "approval-required";
  return current === "approval-required" ? "auto-accept-edits" : current;
}

const ROLE_MODE_LABELS: Record<RoleMode, string> = { act: "Act", ask: "Ask first" };

/** The composer's provider and model choices for one environment. */
function useModelPickerData(environmentId: EnvironmentId, selection: ModelSelection | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  return { settings, providers, entries, modelOptions };
}

function RoleModelPicker({
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

function RoleModeSelect({
  value,
  disabled,
  label,
  onChange,
}: {
  readonly value: RoleMode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (mode: RoleMode) => void;
}) {
  return (
    <Select
      value={value}
      {...(disabled ? { disabled } : {})}
      onValueChange={(next) => {
        if (next === "act" || next === "ask") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(next: RoleMode) => ROLE_MODE_LABELS[next]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="act">{ROLE_MODE_LABELS.act}</SelectItem>
        <SelectItem value="ask">{ROLE_MODE_LABELS.ask}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

/**
 * Roles, then the limits on running agents. Roles belong to a project, so they
 * follow the project crumb; limits are environment-wide.
 */
export function CrewSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const members = isProjectScope ? scope.members : [];
  return (
    <SettingsPageContainer>
      {members.length === 0 ? (
        <SettingsSection title="Roles" id={searchableSetting("crew-roles").id}>
          <SettingsRow
            title="Choose a project"
            description="Each project has its own crew. Pick a project above to edit its roles."
          />
        </SettingsSection>
      ) : (
        members.map((member, index) => {
          const environment = connectedEnvironments.find(
            (candidate) => candidate.environmentId === member.environmentId,
          );
          return (
            <CrewRolesSection
              key={`${member.environmentId}:${member.id}`}
              member={member}
              connected={environment !== undefined}
              supported={environment?.serverConfig?.environment.capabilities.bots === true}
              environmentLabel={members.length > 1 ? (member.environmentLabel ?? null) : null}
              searchAnchor={index === 0}
            />
          );
        })
      )}
      <CrewLimitsSettings />
    </SettingsPageContainer>
  );
}

function CrewRolesSection({
  member,
  connected,
  supported,
  environmentLabel,
  searchAnchor,
}: {
  readonly member: SidebarProjectGroupMember;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly environmentLabel: string | null;
  /** Only the first section carries the search anchor, so its id stays unique. */
  readonly searchAnchor: boolean;
}) {
  const environmentId = member.environmentId;
  const projectId = member.id;
  const { settings, providers } = useModelPickerData(environmentId, null);
  const defaultModel = resolveDefaultProviderModelSelection(
    providers,
    resolveProjectSettings(settings ?? DEFAULT_SERVER_SETTINGS, projectId, member).settings
      .defaultModelSelection,
  );
  const configuration = useEnvironmentQuery(
    connected && supported
      ? botsEnvironment.configuration({ environmentId, input: { projectId } })
      : null,
  );
  const initialize = useAtomCommand(botsEnvironment.initialize);
  const [editor, setEditor] = useState<{ template: BotTemplateConfig | null } | null>(null);
  const [initializing, setInitializing] = useState(false);
  const templates = configuration.data?.templates ?? [];
  // Environment roles (the Captain) lead, as they sit above every project crew.
  const roles = [
    ...templates.filter((template) => template.projectId === null),
    ...templates.filter((template) => template.projectId !== null),
  ];
  const hasCrew = templates.some((template) => template.id === `template:manager:${projectId}`);
  const title = environmentLabel ? `Roles · ${environmentLabel}` : "Roles";

  const addStarterCrew = async () => {
    if (!defaultModel) return;
    setInitializing(true);
    try {
      const result = await initialize({
        environmentId,
        input: { projectId, modelSelection: defaultModel },
      });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not add the starter crew",
          description: formatEnvironmentQueryError(result.cause),
        });
      }
    } finally {
      setInitializing(false);
    }
  };

  return (
    <SettingsSection
      title={title}
      {...(searchAnchor ? { id: searchableSetting("crew-roles").id } : {})}
      headerAction={
        connected && supported ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultModel || !configuration.data}
            onClick={() => setEditor({ template: null })}
          >
            <PlusIcon className="size-3" />
            Add role
          </Button>
        ) : null
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${member.environmentLabel ?? "this environment"} to edit its crew.`}
        />
      ) : !supported ? (
        <SettingsRow
          title="Crew mode unavailable"
          description="Update this environment to configure a crew."
        />
      ) : configuration.error ? (
        <SettingsRow title="Could not load roles" description={configuration.error} />
      ) : !configuration.data ? (
        <SettingsRow title="Loading roles…" role="status" />
      ) : (
        <>
          {!hasCrew ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No crew yet</EmptyTitle>
                <EmptyDescription>
                  Add the starter crew: a Manager, Planner, Designer, Builder, QA Tester and
                  Reviewer. You can change each one afterwards.
                </EmptyDescription>
              </EmptyHeader>
              <Button
                size="sm"
                disabled={!defaultModel || initializing}
                onClick={() => void addStarterCrew()}
              >
                Add the starter crew
              </Button>
            </Empty>
          ) : null}
          {roles.map((template) => (
            <CrewRoleRow
              key={template.id}
              environmentId={environmentId}
              projectId={projectId}
              template={template}
              onEdit={() => setEditor({ template })}
            />
          ))}
        </>
      )}
      {editor && defaultModel ? (
        <CrewRoleDialog
          environmentId={environmentId}
          projectId={projectId}
          template={editor.template}
          defaultModel={defaultModel}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

type TemplateChange = Partial<
  Pick<
    BotTemplateConfig,
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
function useSaveRole(environmentId: EnvironmentId, projectId: ProjectId) {
  const updateTemplate = useAtomCommand(botsEnvironment.updateTemplate);
  return async (template: BotTemplateConfig, change: TemplateChange) => {
    const next = { ...template, ...change };
    const result = await updateTemplate({
      environmentId,
      input: {
        id: template.id,
        projectId,
        name: next.name,
        instructions: next.instructions,
        allowedTools: [...next.allowedTools],
        modelSelection: next.modelSelection,
        runtimeMode: next.runtimeMode,
        autoCreateForFeature: next.autoCreateForFeature,
        enabled: next.enabled,
        expectedRevision: template.revision,
      },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: `Could not save ${template.name}`,
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

function CrewRoleRow({
  environmentId,
  projectId,
  template,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly template: BotTemplateConfig;
  readonly onEdit: () => void;
}) {
  const save = useSaveRole(environmentId, projectId);
  const [busy, setBusy] = useState(false);
  // Environment roles are shared by every project; they aren't edited from one.
  const environmentWide = template.projectId === null;
  const locked = busy || environmentWide;
  const run = async (change: TemplateChange) => {
    setBusy(true);
    try {
      await save(template, change);
    } finally {
      setBusy(false);
    }
  };
  const summary = template.instructions.split("\n")[0]?.trim() ?? "";
  const status = [
    environmentWide ? "Environment-wide" : null,
    // The Manager joins workflows as the project's own bot, not as a stage role.
    !environmentWide &&
    !template.autoCreateForFeature &&
    template.id !== `template:manager:${projectId}`
      ? "Not available to workflow stages"
      : null,
    template.allowedTools.length > 0 ? `tools: ${template.allowedTools.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingsRow
      aria-disabled={!template.enabled || undefined}
      title={
        <span className="flex items-center gap-1.5">
          {template.name}
          {!template.enabled ? (
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
            selection={template.modelSelection}
            disabled={locked}
            onChange={(modelSelection) => void run({ modelSelection })}
          />
          <RoleModeSelect
            label={`When ${template.name} acts`}
            value={roleMode(template.runtimeMode)}
            disabled={locked}
            onChange={(mode) =>
              void run({ runtimeMode: runtimeModeFor(mode, template.runtimeMode) })
            }
          />
          {!environmentWide ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Actions for ${template.name}`}
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
                <MenuItem onClick={() => void run({ enabled: !template.enabled })}>
                  <PowerIcon />
                  {template.enabled ? "Turn off" : "Turn on"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </>
      }
    />
  );
}

function CrewRoleDialog({
  environmentId,
  projectId,
  template,
  defaultModel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly template: BotTemplateConfig | null;
  readonly defaultModel: ModelSelection;
  readonly onClose: () => void;
}) {
  const createTemplate = useAtomCommand(botsEnvironment.createTemplate);
  const save = useSaveRole(environmentId, projectId);
  const [name, setName] = useState(template?.name ?? "");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [tools, setTools] = useState(template?.allowedTools.join(", ") ?? "");
  const [modelSelection, setModelSelection] = useState(template?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    template?.runtimeMode ?? "auto-accept-edits",
  );
  // Stages pick roles directly, so a role a person adds is available to workflows by default.
  const [workflowStages, setWorkflowStages] = useState(template?.autoCreateForFeature ?? true);
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && instructions.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        instructions: instructions.trim(),
        allowedTools: parseList(tools),
        modelSelection,
        runtimeMode,
        autoCreateForFeature: workflowStages,
      };
      if (template) {
        if (await save(template, fields)) onClose();
        return;
      }
      const result = await createTemplate({
        environmentId,
        input: {
          id: `bot-template:${randomUUID()}`,
          projectId,
          ...fields,
        },
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
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.name}` : "Add role"}</DialogTitle>
          <DialogDescription>
            A role is what a workflow stage runs as: its instructions, tools and default model.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="crew-role-name">Name</Label>
              <Input
                id="crew-role-name"
                value={name}
                maxLength={200}
                placeholder="Security reviewer"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crew-role-instructions">Instructions</Label>
              <Textarea
                id="crew-role-instructions"
                value={instructions}
                maxLength={16_000}
                rows={6}
                placeholder="What this role does and how it reports back"
                onChange={(event) => setInstructions(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crew-role-tools">Crew tools</Label>
              <Input
                id="crew-role-tools"
                value={tools}
                placeholder="Separate with commas"
                onChange={(event) => setTools(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RoleModelPicker
                environmentId={environmentId}
                selection={modelSelection}
                onChange={setModelSelection}
              />
              <RoleModeSelect
                label="When this role acts"
                value={roleMode(runtimeMode)}
                onChange={(mode) => setRuntimeMode(runtimeModeFor(mode, runtimeMode))}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="crew-role-workflow-stages">Workflow stages can use this role</Label>
              <Switch
                id="crew-role-workflow-stages"
                checked={workflowStages}
                onCheckedChange={setWorkflowStages}
              />
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {template ? "Save role" : "Add role"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
