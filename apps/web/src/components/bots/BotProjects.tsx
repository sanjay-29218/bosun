import { useAtomValue } from "@effect/atom-react";
import {
  createProjectOwnerResolver,
  logicalBotHome,
  logicalBotWorksOn,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type { Bot, EnvironmentId, ProjectId, ProjectRemoteBot } from "@t3tools/contracts";
import { BotIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import { logicalBotsAtom } from "../../state/botRail";
import { useConnectedEnvironmentIds } from "../../state/environments";
import type { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { useMoveProjectToLogicalBot } from "../sidebar/moveProjectToBot";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Which bot owns a project. Picking another bot moves the project; work already running stays. */
// The Select's values for a project with no bot and for an owner on another machine; bot ids
// never take these forms.
const NO_BOT = "";
const REMOTE_OWNER = "remote:";

export function BotOwnerSelect({
  environmentId,
  projectId,
  projectTitle,
  botId,
  remoteBot,
  bots,
  loading,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly botId: string | null;
  /** An owner that lives on another machine. */
  readonly remoteBot: ProjectRemoteBot | null;
  readonly bots: readonly Bot[];
  /** The bot list hasn't arrived yet. */
  readonly loading: boolean;
}) {
  const { canMove, moving, move } = useMoveProject(environmentId);
  const owner = botId === null ? undefined : bots.find((bot) => bot.id === botId);
  const value = remoteBot !== null ? REMOTE_OWNER : (botId ?? NO_BOT);

  const change = (next: string) => {
    if (next === value || next === REMOTE_OWNER) return;
    void move({ id: projectId, title: projectTitle }, next === NO_BOT ? null : next);
  };

  return (
    <Select
      value={value}
      // An owner on another machine can still be cleared to No bot when this one has none.
      disabled={moving || !canMove || loading || (bots.length === 0 && remoteBot === null)}
      onValueChange={(next) => {
        if (typeof next === "string") change(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={`Bot that owns ${projectTitle}`}>
        <SelectValue>
          {() =>
            remoteBot !== null ? (
              <RemoteBotOption owner={remoteBot} />
            ) : owner ? (
              <BotOption bot={owner} />
            ) : loading ? (
              "Loading…"
            ) : (
              <span className="text-muted-foreground">No bot</span>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={NO_BOT}>
          <span className="text-muted-foreground">No bot</span>
        </SelectItem>
        {bots.map((bot) => (
          <SelectItem key={bot.id} value={bot.id}>
            <BotOption bot={bot} />
          </SelectItem>
        ))}
        {remoteBot !== null ? (
          <SelectItem value={REMOTE_OWNER}>
            <RemoteBotOption owner={remoteBot} />
          </SelectItem>
        ) : null}
      </SelectPopup>
    </Select>
  );
}

/** An owner from another machine: its avatar when this client has that machine's bots. */
function RemoteBotOption({ owner }: { readonly owner: ProjectRemoteBot }) {
  const bot = useAtomValue(logicalBotsAtom).find(
    (candidate) =>
      logicalBotHome(candidate) === owner.environmentId &&
      candidate.members[0]!.botId === owner.botId,
  );
  return (
    <span className="flex items-center gap-2">
      {bot ? (
        <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" />
      ) : (
        <span className="flex size-4 items-center justify-center rounded-full bg-muted">
          <BotIcon aria-hidden className="size-3 text-muted-foreground" />
        </span>
      )}
      {owner.name}
      <span className="text-muted-foreground">· lives on {owner.homeLabel}</span>
    </span>
  );
}

/** Moves a project to another bot, reporting failures. Work already running stays put. */
function useMoveProject(environmentId: EnvironmentId) {
  const moveProject = useAtomCommand(botsEnvironment.moveProject);
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(environmentId));
  const [moving, setMoving] = useState(false);
  const move = async (project: { id: ProjectId; title: string }, botId: string | null) => {
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

export type EnvironmentProject = ReturnType<typeof useProjects>[number];

/** Why a project on an environment without bots can't be given to one. */
const withoutBosunReason = (environmentLabel: string) =>
  `${environmentLabel} runs T3 Code without Bosun. Install Bosun there to give its projects to a bot.`;

/**
 * A bot's projects on every machine this client knows, each removable, plus a way to add one
 * from its home or a machine linked to it. A project on another machine stays there and is this
 * bot's by its `remoteBot`; adding one there also lets the bot work on that machine.
 */
export function BotProjectList({
  environmentId,
  bot,
  bots,
  ownedProjects,
  availableProjects,
  projectsWithoutBots,
  environmentLabels,
  limitedEnvironmentIds,
  grantAccess,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: LogicalBot;
  readonly bots: readonly LogicalBot[];
  readonly ownedProjects: readonly EnvironmentProject[];
  readonly availableProjects: readonly EnvironmentProject[];
  readonly projectsWithoutBots: readonly EnvironmentProject[];
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  /** Ticks a linked machine under Can work on; the error to show, or null once saved. */
  readonly grantAccess: (environmentId: EnvironmentId) => Promise<string | null>;
  /** Linked machines below full access, where the bot couldn't work on a project it got. */
  readonly limitedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const moveToBot = useMoveProjectToLogicalBot();
  const connected = useConnectedEnvironmentIds();
  const [moving, setMoving] = useState(false);
  const ownerOf = createProjectOwnerResolver(bots);
  const byKey = new Map(bots.map((candidate) => [candidate.key, candidate]));
  const labelOf = (id: EnvironmentId) => environmentLabels.get(id) ?? id;
  // Only another environment's projects name theirs.
  const elsewhere = (project: EnvironmentProject) =>
    project.environmentId === environmentId ? null : labelOf(project.environmentId);
  // A same-named bot elsewhere, such as an old copy of this one, names its machine.
  const ownerName = (project: EnvironmentProject) => {
    const owner = byKey.get(ownerOf(project) ?? "");
    if (owner === undefined) return null;
    return owner.name === bot.name && owner.key !== bot.key
      ? `${owner.name} on ${labelOf(logicalBotHome(owner))}`
      : owner.name;
  };
  // Home first, then the other machines by name.
  const byMachine = (left: EnvironmentProject, right: EnvironmentProject) =>
    Number(left.environmentId !== environmentId) - Number(right.environmentId !== environmentId) ||
    labelOf(left.environmentId).localeCompare(labelOf(right.environmentId));
  const change = async (project: EnvironmentProject, add: boolean) => {
    setMoving(true);
    const fail = (description: string) =>
      toastManager.add({
        type: "error",
        title: `Could not ${add ? "add" : "remove"} ${project.title}`,
        description,
      });
    // Adding a project on a machine the bot may not work on yet lets it work there first.
    const granted =
      add && !logicalBotWorksOn(bot, project.environmentId)
        ? await grantAccess(project.environmentId)
        : null;
    if (granted !== null) fail(granted);
    else {
      const error = await moveToBot(project, add ? bot : null);
      if (error !== null) fail(error);
    }
    setMoving(false);
  };
  const groupByEnvironment = (projects: readonly EnvironmentProject[]) => {
    const groups = new Map<EnvironmentId, EnvironmentProject[]>();
    for (const project of projects) {
      const group = groups.get(project.environmentId) ?? [];
      group.push(project);
      groups.set(project.environmentId, group);
    }
    return [...groups];
  };
  const addable = availableProjects.filter(
    (project) => !limitedEnvironmentIds.has(project.environmentId),
  );
  const limited = availableProjects.filter((project) =>
    limitedEnvironmentIds.has(project.environmentId),
  );
  const canAdd = availableProjects.length > 0 || projectsWithoutBots.length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {ownedProjects.toSorted(byMachine).map((project, index) => {
        const machine = elsewhere(project);
        const offline = machine !== null && !connected.includes(project.environmentId);
        const allowed = logicalBotWorksOn(bot, project.environmentId);
        return (
          <div
            key={`${project.environmentId}:${project.id}`}
            className={cn(
              "flex items-center gap-3 px-3 py-2",
              index > 0 && "border-t border-border/60",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-foreground">{project.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {machine === null ? project.workspaceRoot : `${machine} · ${project.workspaceRoot}`}
              </span>
            </span>
            {offline ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" />
                  }
                >
                  <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
                  Offline
                </TooltipTrigger>
                <TooltipPopup>
                  Can't reach {machine} right now. Requests to it wait and start when it's back.
                </TooltipPopup>
              </Tooltip>
            ) : (
              <>
                {allowed ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground">Not allowed</span>
                )}
                <RemoveButton
                  project={project}
                  botName={bot.name}
                  moving={moving}
                  onClick={() => void change(project, false)}
                />
              </>
            )}
          </div>
        );
      })}
      {ownedProjects.length === 0 || canAdd ? (
        <div
          className={cn(
            "flex items-center gap-3 px-3 py-1.5",
            ownedProjects.length > 0 && "border-t border-border/60",
          )}
        >
          {ownedProjects.length === 0 ? (
            <span className="flex-1 text-xs text-muted-foreground">No projects yet.</span>
          ) : null}
          {canAdd ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost-muted" disabled={moving} />}>
                <PlusIcon className="size-3" />
                Add project
              </MenuTrigger>
              <MenuPopup align="start">
                {addable.length > 0 ? (
                  <MenuGroup>
                    <MenuGroupLabel>Add to {bot.name}</MenuGroupLabel>
                    {addable.toSorted(byMachine).map((project) => (
                      <AddProjectItem
                        key={`${project.environmentId}:${project.id}`}
                        project={project}
                        detail={[elsewhere(project), ownerName(project)]
                          .filter(Boolean)
                          .join(" · ")}
                        onClick={() => void change(project, true)}
                      />
                    ))}
                  </MenuGroup>
                ) : null}
                {groupByEnvironment(limited).map(([projectEnvironmentId, projects]) => (
                  <DisabledProjectGroup
                    key={projectEnvironmentId}
                    label={labelOf(projectEnvironmentId)}
                    reason={`Needs full access. Link ${labelOf(projectEnvironmentId)} again with full access.`}
                    projects={projects}
                  />
                ))}
                {groupByEnvironment(projectsWithoutBots).map(([projectEnvironmentId, projects]) => (
                  <DisabledProjectGroup
                    key={projectEnvironmentId}
                    label={labelOf(projectEnvironmentId)}
                    reason={withoutBosunReason(labelOf(projectEnvironmentId))}
                    projects={projects}
                  />
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One machine's projects this bot can't take, with why. */
function DisabledProjectGroup(props: {
  readonly label: string;
  readonly reason: string;
  readonly projects: readonly EnvironmentProject[];
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>{props.label}</MenuGroupLabel>
      {/* A disabled item can't show a tooltip, so the reason sits above them. */}
      <p className="max-w-64 px-2 pb-1 text-xs text-muted-foreground">{props.reason}</p>
      {props.projects.map((project) => (
        <MenuItem key={project.id} disabled>
          <span className="truncate">{project.title}</span>
        </MenuItem>
      ))}
    </MenuGroup>
  );
}

/** Taking a project off the bot needs permission on the project's own environment. */
function RemoveButton({
  project,
  botName,
  moving,
  onClick,
}: {
  readonly project: EnvironmentProject;
  readonly botName: string;
  readonly moving: boolean;
  readonly onClick: () => void;
}) {
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(project.environmentId));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            disabled={moving || !canMove}
            aria-label={`Remove ${project.title} from ${botName}`}
            onClick={onClick}
          />
        }
      >
        <XIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>Remove from {botName}</TooltipPopup>
    </Tooltip>
  );
}

function AddProjectItem({
  project,
  detail,
  onClick,
}: {
  readonly project: EnvironmentProject;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(project.environmentId));
  return (
    <MenuItem disabled={!canMove} onClick={onClick}>
      <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
        <span className="truncate">{project.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      </span>
    </MenuItem>
  );
}
