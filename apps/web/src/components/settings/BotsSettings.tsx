import { useAtomValue } from "@effect/atom-react";
import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import { BOT_AVATAR_PRESETS, randomBotAvatar } from "@t3tools/client-runtime/bot-avatar";
import {
  BOT_EYES,
  BOT_FACES,
  BOT_HEADS,
  BOT_TOPS,
  DEFAULT_BOT_TOOLS,
  type Bot,
  type BotAvatar as BotAvatarParts,
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconColor,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  BotMessageSquareIcon,
  CheckIcon,
  DicesIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn, randomUUID } from "../../lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconOptions";
import { botsEnvironment } from "../../state/bots";
import { useProjects, useServerConfigs } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { BotAvatar } from "../BotAvatar";
import { Button } from "../ui/button";
import { Dialog, DialogClose } from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { InstructionsEditor } from "../InstructionsEditor";
import { Toggle } from "../ui/toggle";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardTabs } from "../ui/wizard";
import { toastManager } from "../ui/toast";
import { botDeleteBlocker, groupProjectsByBot, moveBotInOrder } from "./BotsSettings.logic";
import { CrewToolPicker, EditorField } from "./CrewAgentFields";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { DisclosureSection } from "../DisclosureSection";
import { CrewLimitsSettings } from "./CrewLimitsSettings";
import { CrewEnvironmentNotice, useCrewSettingsEnvironment } from "./crewSettingsEnvironment";
import {
  RoleModelPicker,
  RuntimeModeSelect,
  useEnvironmentDefaultModel,
} from "../library/RoleEditor";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Top-level bots and the projects each one owns, then the limits on the agents their features
 * run. Bots are environment-local.
 */
export function BotsSettings() {
  const { environment, supported } = useCrewSettingsEnvironment("bots");
  return (
    <SettingsPageContainer>
      {environment && supported ? (
        <BotsSections
          key={environment.environmentId}
          environmentId={environment.environmentId}
          workflowsSupported={environment.serverConfig?.environment.capabilities.workflows === true}
        />
      ) : (
        <SettingsSection title="Bots" id={searchableSetting("bots").id}>
          <CrewEnvironmentNotice
            connected={environment !== null}
            supported={supported}
            noun="bots"
          />
        </SettingsSection>
      )}
      <CrewLimitsSettings />
    </SettingsPageContainer>
  );
}

function BotsSections({
  environmentId,
  workflowsSupported,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflowsSupported: boolean;
}) {
  const botsQuery = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  const workflowsQuery = useEnvironmentQuery(
    workflowsSupported ? workflowsEnvironment.definitions({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = allProjects
    .filter((project) => project.environmentId === environmentId)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const projectsByBot = groupProjectsByBot(projects);
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  const canEdit = useAtomValue(botsEnvironment.update.permissionAtom(environmentId));
  const reorder = useAtomCommand(botsEnvironment.reorder);
  const remove = useAtomCommand(botsEnvironment.delete);
  // The dialog follows the listed bot, so a refresh after a conflict gives it the latest revision.
  const [editor, setEditor] = useState<{ botId: string | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const bots = botsQuery.data ?? [];
  const workflows = workflowsQuery.data ?? [];
  const editingBot = editor?.botId ? (bots.find((bot) => bot.id === editor.botId) ?? null) : null;

  const move = async (bot: Bot, offset: -1 | 1) => {
    const botIds = moveBotInOrder(
      bots.map((candidate) => candidate.id),
      bot.id,
      offset,
    );
    if (!botIds) return;
    setBusyId(bot.id);
    const result = await reorder({ environmentId, input: { botIds } });
    if (result._tag !== "Success")
      toastManager.add({
        type: "error",
        title: `Could not move ${bot.name}`,
        description: formatEnvironmentQueryError(result.cause),
      });
    setBusyId(null);
  };

  const deleteBot = async (bot: Bot) => {
    const confirmed = await requestConfirmDialog(
      `Delete ${bot.name}?\nRuns it already started keep going; it gets no new work.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusyId(bot.id);
    const result = await remove({ environmentId, input: { id: bot.id } });
    if (result._tag !== "Success")
      toastManager.add({
        type: "error",
        title: `Could not delete ${bot.name}`,
        description: formatEnvironmentQueryError(result.cause),
      });
    setBusyId(null);
  };

  return (
    <>
      <SettingsSection
        title="Bots"
        id={searchableSetting("bots").id}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!botsQuery.data || !canEdit}
            onClick={() => setEditor({ botId: null })}
          >
            <PlusIcon className="size-3" />
            Add bot
          </Button>
        }
      >
        {botsQuery.error ? (
          <SettingsRow title="Could not load bots" description={botsQuery.error} />
        ) : !botsQuery.data ? (
          <SettingsRow title="Loading bots…" role="status" />
        ) : bots.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotMessageSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No bots yet</EmptyTitle>
              <EmptyDescription>Add a bot to look after your projects.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          bots.map((bot, index) => (
            <BotRow
              key={bot.id}
              environmentId={environmentId}
              bot={bot}
              bots={bots}
              ownedProjects={projectsByBot.get(bot.id) ?? []}
              allProjects={projects}
              first={index === 0}
              last={index === bots.length - 1}
              disabled={!canEdit || busyId !== null}
              onEdit={() => setEditor({ botId: bot.id })}
              onMove={(offset) => void move(bot, offset)}
              onDelete={() => void deleteBot(bot)}
            />
          ))
        )}
      </SettingsSection>
      {/* A bot deleted elsewhere while open closes its dialog rather than turning it into Add. */}
      {editor && (editor.botId === null || editingBot) ? (
        <BotDialog
          environmentId={environmentId}
          bot={editingBot}
          usedAvatars={bots.map((bot) => bot.avatar)}
          onConflict={botsQuery.refresh}
          defaultModel={defaultModel}
          workflows={workflows}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

/** Which bot owns a project. Picking another bot moves the project; work already running stays. */
function BotOwnerSelect({
  environmentId,
  projectId,
  projectTitle,
  botId,
  bots,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly botId: string;
  readonly bots: readonly Bot[];
}) {
  const { canMove, moving, move } = useMoveProject(environmentId);
  const owner = bots.find((bot) => bot.id === botId);

  const change = (next: string) => {
    if (next === botId) return;
    void move({ id: projectId, title: projectTitle }, next);
  };

  return (
    <Select
      value={botId}
      disabled={moving || !canMove || bots.length === 0}
      onValueChange={(next) => {
        if (typeof next === "string") change(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={`Bot that owns ${projectTitle}`}>
        <SelectValue>
          {() => (owner ? <BotOption bot={owner} /> : bots.length === 0 ? "Loading…" : "")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {bots.map((bot) => (
          <SelectItem key={bot.id} value={bot.id}>
            <BotOption bot={bot} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Moves a project to another bot, reporting failures. Work already running stays put. */
function useMoveProject(environmentId: EnvironmentId) {
  const moveProject = useAtomCommand(botsEnvironment.moveProject);
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(environmentId));
  const [moving, setMoving] = useState(false);
  const move = async (project: { id: ProjectId; title: string }, botId: string) => {
    setMoving(true);
    const result = await moveProject({ environmentId, input: { projectId: project.id, botId } });
    if (result._tag !== "Success")
      toastManager.add({
        type: "error",
        title: `Could not move ${project.title}`,
        description: formatEnvironmentQueryError(result.cause),
      });
    setMoving(false);
  };
  return { canMove, moving, move };
}

function BotOption({ bot }: { readonly bot: Pick<Bot, "name" | "avatar" | "color"> }) {
  return (
    <span className="flex items-center gap-2">
      <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" />
      {bot.name}
    </span>
  );
}

type EnvironmentProject = ReturnType<typeof useProjects>[number];

function BotRow({
  environmentId,
  bot,
  bots,
  ownedProjects,
  allProjects,
  first,
  last,
  disabled,
  onEdit,
  onMove,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly bots: readonly Bot[];
  readonly ownedProjects: readonly EnvironmentProject[];
  readonly allProjects: readonly EnvironmentProject[];
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  const summary = bot.instructions.split("\n")[0]?.trim() ?? "";
  const deleteBlocker = botDeleteBlocker(bot.id, ownedProjects.length);
  const projectCount = `${ownedProjects.length} ${ownedProjects.length === 1 ? "project" : "projects"}`;

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <BotAvatar avatar={bot.avatar} color={bot.color} size="sm" />
          {bot.name}
        </span>
      }
      description={[bot.modelSelection?.model ?? null, runtimeModeConfig[bot.runtimeMode].label]
        .filter(Boolean)
        .join(" · ")}
      status={
        // Runs need a model; the server doesn't fall back to the environment's default.
        bot.modelSelection
          ? summary.length > 120
            ? `${summary.slice(0, 117)}…`
            : summary
          : "No model yet. Edit it to choose one before it can run."
      }
      control={
        <>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onEdit}>
            <PencilIcon />
            Edit
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Actions for ${bot.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={first} onClick={() => onMove(-1)}>
                <ArrowUpIcon />
                Move up
              </MenuItem>
              <MenuItem disabled={last} onClick={() => onMove(1)}>
                <ArrowDownIcon />
                Move down
              </MenuItem>
              <MenuItem variant="destructive" disabled={deleteBlocker !== null} onClick={onDelete}>
                <Trash2Icon />
                <span className="flex flex-col">
                  Delete
                  {/* A disabled item can't show a tooltip, so the reason sits under it. */}
                  {deleteBlocker ? (
                    <span className="text-xs text-muted-foreground">{deleteBlocker}</span>
                  ) : null}
                </span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      <div className="mt-2 mb-2">
        <DisclosureSection title="Projects" summary={projectCount}>
          <BotProjectList
            environmentId={environmentId}
            bot={bot}
            bots={bots}
            ownedProjects={ownedProjects}
            allProjects={allProjects}
          />
        </DisclosureSection>
      </div>
    </SettingsRow>
  );
}

/** A bot's projects, each movable to another bot, plus a way to bring one over. */
function BotProjectList({
  environmentId,
  bot,
  bots,
  ownedProjects,
  allProjects,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly bots: readonly Bot[];
  readonly ownedProjects: readonly EnvironmentProject[];
  readonly allProjects: readonly EnvironmentProject[];
}) {
  const { canMove, moving, move } = useMoveProject(environmentId);
  const otherBots = bots.filter((candidate) => candidate.id !== bot.id);
  const botNames = new Map(bots.map((candidate) => [candidate.id, candidate.name]));
  const incoming = allProjects.filter((project) => projectBotId(project) !== bot.id);
  const locked = moving || !canMove;

  return (
    // Bordered like other nested lists in Settings.
    <div className="overflow-hidden rounded-lg border border-border/60">
      {ownedProjects.map((project, index) => (
        <div
          key={project.id}
          className={cn(
            "flex items-center gap-3 px-3 py-2",
            index > 0 && "border-t border-border/60",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{project.title}</span>
            <span className="truncate text-xs text-muted-foreground">{project.workspaceRoot}</span>
          </span>
          {otherBots.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={locked}
                    aria-label={`Move ${project.title} to another bot`}
                  />
                }
              >
                <ArrowRightLeftIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Move to</MenuGroupLabel>
                  {otherBots.map((target) => (
                    <MenuItem key={target.id} onClick={() => void move(project, target.id)}>
                      <BotOption bot={target} />
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ))}
      {ownedProjects.length === 0 || incoming.length > 0 ? (
        <div
          className={cn(
            "flex items-center gap-3 px-3 py-1.5",
            ownedProjects.length > 0 && "border-t border-border/60",
          )}
        >
          {ownedProjects.length === 0 ? (
            <span className="flex-1 text-xs text-muted-foreground">No projects yet.</span>
          ) : null}
          {incoming.length > 0 ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost-muted" disabled={locked} />}>
                <PlusIcon className="size-3" />
                Add project
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuGroup>
                  <MenuGroupLabel>Move to {bot.name}</MenuGroupLabel>
                  {incoming.map((project) => (
                    <MenuItem key={project.id} onClick={() => void move(project, bot.id)}>
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                        <span className="truncate">{project.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {botNames.get(projectBotId(project))}
                        </span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type BotChange = Partial<
  Pick<
    Bot,
    | "name"
    | "avatar"
    | "color"
    | "instructions"
    | "allowedTools"
    | "modelSelection"
    | "runtimeMode"
    | "defaultWorkflowId"
  >
>;

/** Saves a bot. A failed save reloads the list, so another try uses the latest revision. */
function useSaveBot(environmentId: EnvironmentId, onFailure: () => void) {
  const update = useAtomCommand(botsEnvironment.update);
  return async (bot: Bot, change: BotChange) => {
    const result = await update({
      environmentId,
      input: { id: bot.id, expectedRevision: bot.revision, ...change },
    });
    if (result._tag === "Success") return true;
    onFailure();
    toastManager.add({
      type: "error",
      title: `Could not save ${bot.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };
}

const NO_WORKFLOW = "none";

/** Add bot outside Settings: the bot rail's +. `onCreated` gets the new bot. */
export function AddBotDialog({
  environmentId,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onCreated: (bot: Bot) => void;
}) {
  const workflowsSupported =
    useServerConfigs().get(environmentId)?.environment.capabilities.workflows === true;
  const workflowsQuery = useEnvironmentQuery(
    workflowsSupported ? workflowsEnvironment.definitions({ environmentId, input: {} }) : null,
  );
  const botsQuery = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  return (
    <BotDialog
      environmentId={environmentId}
      bot={null}
      defaultModel={defaultModel}
      workflows={workflowsQuery.data ?? []}
      usedAvatars={(botsQuery.data ?? []).map((bot) => bot.avatar)}
      onConflict={botsQuery.refresh}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}

function BotDialog({
  environmentId,
  bot,
  defaultModel,
  workflows,
  usedAvatars,
  onClose,
  onConflict,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly defaultModel: ModelSelection | null;
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Avatars other bots wear; a new bot starts with a starter one nobody has. */
  readonly usedAvatars: ReadonlyArray<BotAvatarParts>;
  readonly onClose: () => void;
  readonly onConflict: () => void;
  readonly onCreated?: (bot: Bot) => void;
}) {
  const create = useAtomCommand(botsEnvironment.create);
  const save = useSaveBot(environmentId, onConflict);
  // One id per dialog: retrying after a lost response returns the bot already made.
  const [newBotId] = useState(() => `bot-${randomUUID()}`);
  const [name, setName] = useState(bot?.name ?? "");
  const [avatar, setAvatar] = useState<BotAvatarParts>(
    () =>
      bot?.avatar ??
      BOT_AVATAR_PRESETS.find(
        (preset) => !usedAvatars.some((used) => JSON.stringify(used) === JSON.stringify(preset)),
      ) ??
      randomBotAvatar(),
  );
  const [color, setColor] = useState<ProjectIconColor>(bot?.color ?? "blue");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [tools, setTools] = useState<ReadonlyArray<string>>(bot?.allowedTools ?? DEFAULT_BOT_TOOLS);
  const [modelSelection, setModelSelection] = useState(bot?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    bot?.runtimeMode ?? "approval-required",
  );
  const [defaultWorkflowId, setDefaultWorkflowId] = useState(bot?.defaultWorkflowId ?? null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"behavior" | "tools" | "look">("behavior");
  // A new bot may leave instructions empty to start from the server's defaults.
  const canSave =
    name.trim().length > 0 &&
    modelSelection !== null &&
    (bot === null || instructions.trim().length > 0) &&
    !saving;
  // A default workflow that was deleted still shows, so saving doesn't drop it silently.
  const workflowOptions =
    defaultWorkflowId && !workflows.some((workflow) => workflow.id === defaultWorkflowId)
      ? [...workflows, { id: defaultWorkflowId, name: defaultWorkflowId }]
      : workflows;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    await (async () => {
      const fields = {
        name: name.trim(),
        avatar,
        color,
        allowedTools: tools,
        runtimeMode,
        modelSelection,
        defaultWorkflowId,
      };
      if (bot) {
        if (await save(bot, { ...fields, instructions: instructions.trim() })) onClose();
        return;
      }
      const result = await create({
        environmentId,
        input: {
          id: newBotId,
          ...fields,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        },
      });
      if (result._tag === "Success") {
        onCreated?.(result.value);
        onClose();
      } else
        toastManager.add({
          type: "error",
          title: "Could not add the bot",
          description: formatEnvironmentQueryError(result.cause),
        });
    })();
    setSaving(false);
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
          title={bot ? `Edit ${bot.name}` : "New bot"}
          description="A bot owns projects and runs their work with the tools and model you give it."
        >
          <WizardTabs
            label="Bot settings"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: "behavior", label: "Behavior", icon: <SlidersHorizontalIcon /> },
              { value: "tools", label: `Tools · ${tools.length}`, icon: <WrenchIcon /> },
              { value: "look", label: "Look", icon: <PaletteIcon /> },
            ]}
          />
        </WizardHeader>
        {/* One height for every tab, so switching doesn't resize the dialog. */}
        <WizardPanel className="min-h-[30rem]">
          <fieldset disabled={saving} className="space-y-5">
            <div className="flex items-center gap-4">
              <BotAvatar avatar={avatar} color={color} size="lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="bot-name">Name</Label>
                <Input
                  id="bot-name"
                  value={name}
                  maxLength={80}
                  placeholder="Social"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            {tab === "behavior" ? (
              <>
                <EditorField label="Instructions" htmlFor="bot-instructions">
                  <InstructionsEditor
                    id="bot-instructions"
                    label="Instructions"
                    value={instructions}
                    maxLength={16_000}
                    disabled={saving}
                    placeholder={
                      bot
                        ? "What this bot does for its projects"
                        : "Leave empty to coordinate its projects' managers"
                    }
                    onChange={setInstructions}
                  />
                </EditorField>
                <div className="grid gap-5 sm:grid-cols-2">
                  <EditorField label="Model">
                    <div>
                      {modelSelection ? (
                        <RoleModelPicker
                          environmentId={environmentId}
                          selection={modelSelection}
                          onChange={setModelSelection}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No model available. Set up a provider first.
                        </p>
                      )}
                    </div>
                  </EditorField>
                  <EditorField label="Access">
                    <RuntimeModeSelect
                      label="Access"
                      value={runtimeMode}
                      onChange={setRuntimeMode}
                    />
                  </EditorField>
                </div>
                <EditorField label="Default workflow">
                  <Select
                    value={defaultWorkflowId ?? NO_WORKFLOW}
                    onValueChange={(next) =>
                      setDefaultWorkflowId(
                        typeof next === "string" && next !== NO_WORKFLOW ? next : null,
                      )
                    }
                  >
                    <SelectTrigger aria-label="Default workflow">
                      <SelectValue>
                        {(value: string) =>
                          value === NO_WORKFLOW
                            ? "None"
                            : (workflowOptions.find((workflow) => workflow.id === value)?.name ??
                              value)
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={NO_WORKFLOW}>None</SelectItem>
                      {workflowOptions.map((workflow) => (
                        <SelectItem key={workflow.id} value={workflow.id}>
                          {workflow.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </EditorField>
              </>
            ) : tab === "tools" ? (
              <EditorField label="Tools">
                <CrewToolPicker value={tools} onChange={setTools} forBot />
              </EditorField>
            ) : (
              <>
                <EditorField label="Look">
                  <BotAvatarPicker value={avatar} color={color} onChange={setAvatar} />
                </EditorField>
                <EditorField label="Color">
                  <BotColorPicker value={color} onChange={setColor} />
                </EditorField>
              </>
            )}
          </fieldset>
        </WizardPanel>
        <WizardFooter>
          <DialogClose render={<Button variant="ghost-muted" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {bot ? "Save" : "Add bot"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const PART_LABELS = {
  head: {
    squircle: "Square head",
    round: "Round head",
    wide: "Wide head",
    tall: "Tall head",
    dome: "Dome head",
    cat: "Cat head",
    peak: "Peak head",
    gem: "Gem head",
  },
  face: { visor: "Visor", plate: "Face plate", bare: "Bare face", flat: "Flat" },
  eyes: {
    round: "Round eyes",
    happy: "Happy eyes",
    wink: "Wink",
    sleepy: "Sleepy eyes",
    star: "Star eyes",
    tall: "Tall eyes",
    visor: "Eye bar",
    heart: "Heart eyes",
    big: "Big eyes",
    dash: "Dash eyes",
  },
  top: {
    ball: "Antenna",
    double: "Two antennas",
    ears: "Side pods",
    sprout: "Sprout",
    propeller: "Propeller",
    headphones: "Headphones",
    bow: "Bow",
    halo: "Halo",
    horns: "Horns",
    none: "Nothing on top",
  },
} as const;

/** Builds a bot's avatar part by part; each choice shows the bot wearing it. */
function BotAvatarPicker({
  value,
  color,
  onChange,
}: {
  readonly value: BotAvatarParts;
  readonly color: ProjectIconColor;
  readonly onChange: (avatar: BotAvatarParts) => void;
}) {
  const parts = [
    { key: "head", label: "Head", options: BOT_HEADS },
    { key: "face", label: "Face", options: BOT_FACES },
    { key: "eyes", label: "Eyes", options: BOT_EYES },
    { key: "top", label: "Top", options: BOT_TOPS },
  ] as const;
  return (
    <div className="space-y-2">
      {parts.map((part) => (
        <div key={part.key} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">{part.label}</span>
          <div role="radiogroup" aria-label={part.label} className="flex flex-wrap gap-1">
            {part.options.map((option) => {
              const selected = value[part.key] === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={(PART_LABELS[part.key] as Record<string, string>)[option]}
                  className={cn(
                    "grid size-10 place-items-center rounded-lg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? "bg-accent inset-ring inset-ring-foreground/25"
                      : "hover:bg-accent/60",
                  )}
                  onClick={() => onChange({ ...value, [part.key]: option })}
                >
                  <BotAvatar avatar={{ ...value, [part.key]: option }} color={color} size={34} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 sm:pl-13">
        <Toggle
          variant="outline"
          size="compact"
          pressed={value.cheeks}
          onPressedChange={(cheeks) => onChange({ ...value, cheeks })}
        >
          Cheeks
        </Toggle>
        <Toggle
          variant="outline"
          size="compact"
          pressed={value.smile}
          onPressedChange={(smile) => onChange({ ...value, smile })}
        >
          Smile
        </Toggle>
        <Button variant="ghost-muted" size="xs" onClick={() => onChange(randomBotAvatar())}>
          <DicesIcon />
          Shuffle
        </Button>
      </div>
    </div>
  );
}

/** The project colors as swatches. */
function BotColorPicker({
  value,
  onChange,
}: {
  readonly value: ProjectIconColor;
  readonly onChange: (color: ProjectIconColor) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
      {PROJECT_ICON_COLORS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            className={cn(
              "grid size-6 place-items-center rounded-full text-white outline-none hover:opacity-85 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground",
              option.swatchClassName,
            )}
            onClick={() => onChange(option.value)}
          >
            {selected ? <CheckIcon aria-hidden className="size-3.5" strokeWidth={3} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Project settings: the bot that owns each of the project's checkouts. */
export function ProjectBotSection({
  members,
}: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly botId?: string | undefined;
    readonly environmentLabel: string | null;
  }>;
}) {
  if (members.length === 0) return null;
  return (
    <SettingsSection title="Bot" id={searchableSetting("project-bot").id}>
      {members.map((member) => (
        <ProjectBotRow
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectBotRow({
  member,
  showEnvironment,
}: {
  readonly member: Parameters<typeof ProjectBotSection>[0]["members"][number];
  readonly showEnvironment: boolean;
}) {
  const bots = useEnvironmentQuery(
    botsEnvironment.list({ environmentId: member.environmentId, input: {} }),
  );
  return (
    <SettingsRow
      title={showEnvironment ? (member.environmentLabel ?? "Environment") : "Owner"}
      description={
        bots.error ?? "The bot that runs this project's work. Its threads show under that bot."
      }
      control={
        <BotOwnerSelect
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          botId={projectBotId(member)}
          bots={bots.data ?? []}
        />
      }
    />
  );
}
