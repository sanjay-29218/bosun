import { useAtomValue } from "@effect/atom-react";
import type {
  Bot,
  EnvironmentId,
  ModelSelection,
  ProjectIconColor,
  ProjectId,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotMessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn, randomUUID } from "../../lib/utils";
import { firstEmoji, PROJECT_ICON_COLORS } from "../../projectIconOptions";
import { botsEnvironment } from "../../state/bots";
import { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
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
import { toastManager } from "../ui/toast";
import {
  botDeleteBlocker,
  countProjectsByBot,
  moveBotInOrder,
  projectBotId,
} from "./BotsSettings.logic";
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
import { parseList } from "./WorkflowEditor.logic";

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
  const [editor, setEditor] = useState<{ bot: Bot | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const bots = botsQuery.data ?? [];
  const workflows = workflowsQuery.data ?? [];

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
            onClick={() => setEditor({ bot: null })}
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
              defaultModel={defaultModel}
              ownedProjects={projectCounts.get(bot.id) ?? 0}
              first={index === 0}
              last={index === bots.length - 1}
              disabled={!canEdit || busyId !== null}
              onEdit={() => setEditor({ bot })}
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
      {editor ? (
        <BotDialog
          environmentId={environmentId}
          bot={editor.bot}
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
          {() => (owner ? `${owner.emoji} ${owner.name}` : bots.length === 0 ? "Loading…" : "")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {bots.map((bot) => (
          <SelectItem key={bot.id} value={bot.id}>
            {bot.emoji} {bot.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function BotRow({
  environmentId,
  bot,
  defaultModel,
  ownedProjects,
  first,
  last,
  disabled,
  onEdit,
  onMove,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly defaultModel: ModelSelection | null;
  readonly ownedProjects: number;
  readonly first: boolean;
  readonly last: boolean;
  readonly disabled: boolean;
  readonly onEdit: () => void;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onDelete: () => void;
}) {
  const save = useSaveBot(environmentId);
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
  const model = bot.modelSelection ?? defaultModel;
  return (
    <SettingsRow
      title={`${bot.emoji} ${bot.name}`}
      description={summary.length > 160 ? `${summary.slice(0, 157)}…` : summary}
      status={[
        ownedProjects === 1 ? "1 project" : `${ownedProjects} projects`,
        bot.modelSelection ? null : "Uses the default model until you pick one",
      ]
        .filter(Boolean)
        .join(" · ")}
      control={
        <>
          {model ? (
            <RoleModelPicker
              environmentId={environmentId}
              selection={model}
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
    | "emoji"
    | "color"
    | "instructions"
    | "allowedTools"
    | "modelSelection"
    | "runtimeMode"
    | "defaultWorkflowId"
  >
>;

function useSaveBot(environmentId: EnvironmentId) {
  const update = useAtomCommand(botsEnvironment.update);
  return async (bot: Bot, change: BotChange) => {
    const result = await update({
      environmentId,
      input: { id: bot.id, expectedRevision: bot.revision, ...change },
    });
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: `Could not save ${bot.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };
}

const NO_WORKFLOW = "none";

function BotDialog({
  environmentId,
  bot,
  defaultModel,
  workflows,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly defaultModel: ModelSelection | null;
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly onClose: () => void;
}) {
  const create = useAtomCommand(botsEnvironment.create);
  const save = useSaveBot(environmentId);
  const [name, setName] = useState(bot?.name ?? "");
  const [emojiText, setEmojiText] = useState(bot?.emoji ?? "🤖");
  const [color, setColor] = useState<ProjectIconColor>(bot?.color ?? "blue");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [tools, setTools] = useState(bot?.allowedTools.join(", ") ?? "");
  const [modelSelection, setModelSelection] = useState(bot?.modelSelection ?? defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    bot?.runtimeMode ?? "approval-required",
  );
  const [defaultWorkflowId, setDefaultWorkflowId] = useState(bot?.defaultWorkflowId ?? null);
  const [saving, setSaving] = useState(false);
  const emoji = firstEmoji(emojiText);
  // A new bot may leave instructions empty to start from the server's defaults.
  const canSave =
    name.trim().length > 0 &&
    emoji !== null &&
    (bot === null || instructions.trim().length > 0) &&
    !saving;
  // A default workflow that was deleted still shows, so saving doesn't drop it silently.
  const workflowOptions =
    defaultWorkflowId && !workflows.some((workflow) => workflow.id === defaultWorkflowId)
      ? [...workflows, { id: defaultWorkflowId, name: defaultWorkflowId }]
      : workflows;

  const submit = async () => {
    if (!canSave || emoji === null) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        emoji,
        color,
        runtimeMode,
        modelSelection,
        defaultWorkflowId,
      };
      if (bot) {
        if (
          await save(bot, {
            ...fields,
            instructions: instructions.trim(),
            allowedTools: parseList(tools),
          })
        )
          onClose();
        return;
      }
      const result = await create({
        environmentId,
        input: {
          id: `bot-${randomUUID()}`,
          ...fields,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          ...(tools.trim() ? { allowedTools: parseList(tools) } : {}),
        },
      });
      if (result._tag === "Success") onClose();
      else
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
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{bot ? `Edit ${bot.name}` : "Add bot"}</DialogTitle>
          <DialogDescription>
            A bot owns projects and runs their work: its instructions, tools, default model and the
            workflow its features start with.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-4">
            <div className="flex gap-3">
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
              <div className="w-24 space-y-1.5">
                <Label htmlFor="bot-emoji">Emoji</Label>
                <Input
                  id="bot-emoji"
                  value={emojiText}
                  aria-invalid={emoji === null}
                  onChange={(event) => setEmojiText(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Color</Label>
                <Select
                  value={color}
                  onValueChange={(next) => {
                    const option = PROJECT_ICON_COLORS.find(
                      (candidate) => candidate.value === next,
                    );
                    if (option) setColor(option.value);
                  }}
                >
                  <SelectTrigger aria-label="Color">
                    <SelectValue>
                      {(value: ProjectIconColor) => <ColorOption value={value} />}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {PROJECT_ICON_COLORS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <ColorOption value={option.value} />
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-instructions">Instructions</Label>
              <Textarea
                id="bot-instructions"
                value={instructions}
                maxLength={16_000}
                rows={6}
                placeholder={
                  bot
                    ? "What this bot does for its projects"
                    : "Leave empty to coordinate its projects' managers"
                }
                onChange={(event) => setInstructions(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-tools">Crew tools</Label>
              <Input
                id="bot-tools"
                value={tools}
                placeholder={bot ? "Separate with commas" : "crew.delegate, crew.status"}
                onChange={(event) => setTools(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {modelSelection ? (
                <RoleModelPicker
                  environmentId={environmentId}
                  selection={modelSelection}
                  onChange={setModelSelection}
                />
              ) : null}
              <RoleModeSelect
                label="When this bot acts"
                value={roleMode(runtimeMode)}
                onChange={(mode) => setRuntimeMode(runtimeModeFor(mode, runtimeMode))}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label>Default workflow</Label>
              <Select
                value={defaultWorkflowId ?? NO_WORKFLOW}
                onValueChange={(next) =>
                  setDefaultWorkflowId(
                    typeof next === "string" && next !== NO_WORKFLOW ? next : null,
                  )
                }
              >
                <SelectTrigger size="sm" aria-label="Default workflow">
                  <SelectValue>
                    {(value: string) =>
                      value === NO_WORKFLOW
                        ? "None"
                        : (workflowOptions.find((workflow) => workflow.id === value)?.name ?? value)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={NO_WORKFLOW}>None</SelectItem>
                  {workflowOptions.map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={!canSave} onClick={() => void submit()}>
            {bot ? "Save bot" : "Add bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ColorOption({ value }: { readonly value: ProjectIconColor }) {
  const option = PROJECT_ICON_COLORS.find((candidate) => candidate.value === value);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={cn("size-3 rounded-full", option?.swatchClassName)} />
      {option?.label ?? value}
    </span>
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
