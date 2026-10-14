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
  ArrowUpIcon,
  BotMessageSquareIcon,
  CheckIcon,
  DicesIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

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
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";
import { Toggle as TabToggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { botDeleteBlocker, countProjectsByBot, moveBotInOrder } from "./BotsSettings.logic";
import { CrewModeToggle, CrewToolPicker, EditorField } from "./CrewAgentFields";
import { CrewEnvironmentNotice, useCrewSettingsEnvironment } from "./crewSettingsEnvironment";
import {
  RoleModelPicker,
  RoleModeSelect,
  roleMode,
  runtimeModeFor,
  useEnvironmentDefaultModel,
} from "./RolesSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Top-level bots and the projects each one owns. Bots are environment-local. */
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
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, environmentId],
  );
  const projectCounts = useMemo(() => countProjectsByBot(projects), [projects]);
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
    try {
      const result = await reorder({ environmentId, input: { botIds } });
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: `Could not move ${bot.name}`,
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setBusyId(null);
    }
  };

  const deleteBot = async (bot: Bot) => {
    const confirmed = await requestConfirmDialog(
      `Delete ${bot.name}?\nRuns it already started keep going; it gets no new work.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusyId(bot.id);
    try {
      const result = await remove({ environmentId, input: { id: bot.id } });
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: `Could not delete ${bot.name}`,
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setBusyId(null);
    }
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
              <EmptyDescription>Update this environment to get Captain.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          bots.map((bot, index) => (
            <BotRow
              key={bot.id}
              environmentId={environmentId}
              bot={bot}
              ownedProjects={projectCounts.get(bot.id) ?? 0}
              first={index === 0}
              last={index === bots.length - 1}
              disabled={!canEdit || busyId !== null}
              onConflict={botsQuery.refresh}
              onEdit={() => setEditor({ botId: bot.id })}
              onMove={(offset) => void move(bot, offset)}
              onDelete={() => void deleteBot(bot)}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Projects" id={searchableSetting("bot-projects").id}>
        {projects.length === 0 ? (
          <SettingsRow
            title="No projects"
            description="Projects you add on this environment show up here."
          />
        ) : (
          projects.map((project) => (
            <SettingsRow
              key={project.id}
              title={project.title}
              description={project.workspaceRoot}
              control={
                <BotOwnerSelect
                  environmentId={environmentId}
                  projectId={project.id}
                  projectTitle={project.title}
                  botId={projectBotId(project)}
                  bots={bots}
                />
              }
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
export function BotOwnerSelect({
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
  const moveProject = useAtomCommand(botsEnvironment.moveProject);
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(environmentId));
  const [moving, setMoving] = useState(false);
  const owner = bots.find((bot) => bot.id === botId);

  const change = async (next: string) => {
    if (next === botId) return;
    setMoving(true);
    try {
      const result = await moveProject({ environmentId, input: { projectId, botId: next } });
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: `Could not move ${projectTitle}`,
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setMoving(false);
    }
  };

  return (
    <Select
      value={botId}
      disabled={moving || !canMove || bots.length === 0}
      onValueChange={(next) => {
        if (typeof next === "string") void change(next);
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

function BotOption({ bot }: { readonly bot: Pick<Bot, "name" | "avatar" | "color"> }) {
  return (
    <span className="flex items-center gap-2">
      <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" />
      {bot.name}
    </span>
  );
}

function BotRow({
  environmentId,
  bot,
  ownedProjects,
  first,
  last,
  disabled,
  onEdit,
  onMove,
  onDelete,
  onConflict,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly ownedProjects: number;
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
  readonly onConflict: () => void;
}) {
  const save = useSaveBot(environmentId, onConflict);
  const [busy, setBusy] = useState(false);
  const locked = busy || disabled;
  const run = async (change: BotChange) => {
    setBusy(true);
    try {
      await save(bot, change);
    } finally {
      setBusy(false);
    }
  };
  const summary = bot.instructions.split("\n")[0]?.trim() ?? "";
  const deleteBlocker = botDeleteBlocker(bot.id, ownedProjects);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <BotAvatar avatar={bot.avatar} color={bot.color} size="sm" />
          {bot.name}
        </span>
      }
      description={summary.length > 160 ? `${summary.slice(0, 157)}…` : summary}
      status={[
        ownedProjects === 1 ? "1 project" : `${ownedProjects} projects`,
        // Runs need a model; the server doesn't fall back to the environment's default.
        bot.modelSelection ? null : "No model yet. Edit it to choose one before it can run.",
      ]
        .filter(Boolean)
        .join(" · ")}
      control={
        <>
          {bot.modelSelection ? (
            <RoleModelPicker
              environmentId={environmentId}
              selection={bot.modelSelection}
              disabled={locked}
              onChange={(modelSelection) => void run({ modelSelection })}
            />
          ) : null}
          <RoleModeSelect
            label={`When ${bot.name} acts`}
            value={roleMode(bot.runtimeMode)}
            disabled={locked}
            onChange={(mode) => void run({ runtimeMode: runtimeModeFor(mode, bot.runtimeMode) })}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={locked}
                  aria-label={`Actions for ${bot.name}`}
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
    />
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
    try {
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
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{bot ? `Edit ${bot.name}` : "New bot"}</DialogTitle>
          <DialogDescription>
            A bot owns projects and runs their work with the tools and model you give it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            <div className="flex items-end gap-4">
              <BotAvatar avatar={avatar} color={color} size="lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
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
            <ToggleGroup
              aria-label="Bot settings"
              className="w-full"
              value={[tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "behavior" || value === "tools" || value === "look") setTab(value);
              }}
            >
              <TabToggle value="behavior" className="flex-1">
                Behavior
              </TabToggle>
              <TabToggle value="tools" className="flex-1">
                Tools · {tools.length}
              </TabToggle>
              <TabToggle value="look" className="flex-1">
                Look
              </TabToggle>
            </ToggleGroup>
            {/* One height for every tab, so switching doesn't resize the dialog. */}
            <div className="min-h-[26rem] space-y-6">
              {tab === "behavior" ? (
                <>
                  <EditorField
                    label="Instructions"
                    htmlFor="bot-instructions"
                    hint="How it handles requests for its projects."
                  >
                    <Textarea
                      id="bot-instructions"
                      value={instructions}
                      maxLength={16_000}
                      rows={7}
                      placeholder={
                        bot
                          ? "What this bot does for its projects"
                          : "Leave empty to coordinate its projects' managers"
                      }
                      onChange={(event) => setInstructions(event.target.value)}
                    />
                  </EditorField>
                  <div className="grid gap-6 sm:grid-cols-2">
                    <EditorField label="Model" hint="Every run starts with it.">
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
                    </EditorField>
                    <EditorField label="Approvals">
                      <CrewModeToggle
                        value={roleMode(runtimeMode)}
                        onChange={(mode) => setRuntimeMode(runtimeModeFor(mode, runtimeMode))}
                      />
                    </EditorField>
                  </div>
                  <EditorField
                    label="Default workflow"
                    hint="Features in its projects start with this workflow."
                  >
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
                <EditorField label="Tools" hint="What it can use while it works.">
                  <CrewToolPicker value={tools} onChange={setTools} forBot />
                </EditorField>
              ) : (
                <>
                  <EditorField label="Look" hint="Mix the parts, or shuffle for a surprise.">
                    <BotAvatarPicker value={avatar} color={color} onChange={setAvatar} />
                  </EditorField>
                  <EditorField label="Color">
                    <BotColorPicker value={color} onChange={setColor} />
                  </EditorField>
                </>
              )}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {bot ? "Save" : "Add bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
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
