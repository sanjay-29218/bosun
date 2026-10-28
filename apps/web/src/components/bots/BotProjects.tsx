import { useAtomValue } from "@effect/atom-react";
import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { Bot, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ArrowRightLeftIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { botsEnvironment } from "../../state/bots";
import type { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
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

/** A bot's projects, each movable to another bot, plus a way to bring one over. */
export function BotProjectList({
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
