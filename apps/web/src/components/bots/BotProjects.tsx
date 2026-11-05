import { useAtomValue } from "@effect/atom-react";
import {
  createLogicalBotResolver,
  projectBotId,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type { Bot, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ArrowRightLeftIcon, PlusIcon } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import type { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { useMoveProjectToLogicalBot } from "../sidebar/moveProjectToBot";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

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

export type EnvironmentProject = ReturnType<typeof useProjects>[number];

/** Why a project on an environment without bots can't be given to one. */
const withoutBosunReason = (environmentLabel: string) =>
  `${environmentLabel} runs T3 Code without Bosun. Install Bosun there to give its projects to a bot.`;

/**
 * A bot's projects on every connected environment, each movable to another bot, plus a way to
 * bring one over. A project on another environment goes to this bot's namesake there, which the
 * move creates when that environment doesn't have it yet.
 */
export function BotProjectList({
  environmentId,
  bot,
  bots,
  ownedProjects,
  availableProjects,
  projectsWithoutBots,
  environmentLabels,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: LogicalBot;
  readonly bots: readonly LogicalBot[];
  readonly ownedProjects: readonly EnvironmentProject[];
  readonly availableProjects: readonly EnvironmentProject[];
  readonly projectsWithoutBots: readonly EnvironmentProject[];
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}) {
  const moveToBot = useMoveProjectToLogicalBot();
  const [moving, setMoving] = useState(false);
  const otherBots = bots.filter((candidate) => candidate.key !== bot.key);
  const ownerOf = createLogicalBotResolver(bots);
  const botNames = new Map(bots.map((candidate) => [candidate.key, candidate.name]));
  const labelOf = (id: EnvironmentId) => environmentLabels.get(id) ?? id;
  // Only another environment's projects name theirs.
  const elsewhere = (project: EnvironmentProject) =>
    project.environmentId === environmentId ? null : labelOf(project.environmentId);
  const move = async (project: EnvironmentProject, target: LogicalBot) => {
    setMoving(true);
    const error = await moveToBot(project, target);
    if (error !== null)
      toastManager.add({
        type: "error",
        title: `Could not move ${project.title}`,
        description: error,
      });
    setMoving(false);
  };
  const withoutBotsByEnvironment = new Map<EnvironmentId, EnvironmentProject[]>();
  for (const project of projectsWithoutBots) {
    const group = withoutBotsByEnvironment.get(project.environmentId) ?? [];
    group.push(project);
    withoutBotsByEnvironment.set(project.environmentId, group);
  }
  const canAdd = availableProjects.length > 0 || projectsWithoutBots.length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      {ownedProjects.map((project, index) => (
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
              {elsewhere(project) === null
                ? project.workspaceRoot
                : `${elsewhere(project)} · ${project.workspaceRoot}`}
            </span>
          </span>
          {otherBots.length > 0 ? (
            <Menu>
              <MoveTrigger
                environmentId={project.environmentId}
                moving={moving}
                render={(disabled) => (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Move ${project.title} to another bot`}
                  />
                )}
              >
                <ArrowRightLeftIcon className="size-4" />
              </MoveTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Move to</MenuGroupLabel>
                  {otherBots.map((target) => (
                    <MenuItem key={target.key} onClick={() => void move(project, target)}>
                      <BotOption bot={target} />
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ))}
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
                {availableProjects.length > 0 ? (
                  <MenuGroup>
                    <MenuGroupLabel>Move to {bot.name}</MenuGroupLabel>
                    {availableProjects.map((project) => (
                      <AddProjectItem
                        key={`${project.environmentId}:${project.id}`}
                        project={project}
                        detail={[
                          elsewhere(project),
                          botNames.get(ownerOf(project.environmentId, projectBotId(project))),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        onClick={() => void move(project, bot)}
                      />
                    ))}
                  </MenuGroup>
                ) : null}
                {[...withoutBotsByEnvironment].map(([projectEnvironmentId, projects]) => (
                  <MenuGroup key={projectEnvironmentId}>
                    <MenuGroupLabel>{labelOf(projectEnvironmentId)}</MenuGroupLabel>
                    {/* A disabled item can't show a tooltip, so the reason sits above them. */}
                    <p className="max-w-64 px-2 pb-1 text-xs text-muted-foreground">
                      {withoutBosunReason(labelOf(projectEnvironmentId))}
                    </p>
                    {projects.map((project) => (
                      <MenuItem key={project.id} disabled>
                        <span className="truncate">{project.title}</span>
                      </MenuItem>
                    ))}
                  </MenuGroup>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Moving needs permission on the project's own environment. */
function MoveTrigger({
  environmentId,
  moving,
  render,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly moving: boolean;
  readonly render: (disabled: boolean) => ReactElement;
  readonly children: ReactNode;
}) {
  const canMove = useAtomValue(botsEnvironment.moveProject.permissionAtom(environmentId));
  return <MenuTrigger render={render(moving || !canMove)}>{children}</MenuTrigger>;
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
