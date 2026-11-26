import {
  createProjectOwnerResolver,
  isManagerPinned,
  projectHasManager,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type {
  EnvironmentId,
  ProjectId,
  ProjectRemoteBot,
  ProjectRemoteManager,
} from "@t3tools/contracts";

interface ListedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly botId?: string | null | undefined;
  readonly remoteBot?: ProjectRemoteBot | null | undefined;
  readonly managerPinned?: boolean | undefined;
  readonly remoteManager?: ProjectRemoteManager | null | undefined;
  readonly isScratch?: true;
  readonly isBotHome?: true;
}

export interface BotsListManager {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The sidebar's key for the project, which Settings → Projects selects by. */
  readonly projectKey: string;
  /** The rail entry of the bot that owns the project, or null for no bot. */
  readonly ownerKey: string | null;
  readonly pinned: boolean;
}

/**
 * Every project manager the Bots list shows, by title: one per project, left out for Scratch,
 * bots' homes, environments without features, which have no managers, and copies whose manager
 * lives on another machine, which lists it there.
 */
export function botsListManagers(input: {
  readonly projects: ReadonlyArray<ListedProject>;
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly managerEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly projectKeyOf: (environmentId: EnvironmentId, projectId: ProjectId) => string | null;
}): BotsListManager[] {
  const ownerOf = createProjectOwnerResolver(input.bots);
  return input.projects
    .flatMap((project) => {
      if (!projectHasManager(project, input.managerEnvironmentIds)) return [];
      const projectKey = input.projectKeyOf(project.environmentId, project.id);
      if (projectKey === null) return [];
      return [
        {
          key: `${project.environmentId}:${project.id}`,
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          projectKey,
          ownerKey: ownerOf(project),
          pinned: isManagerPinned(project),
        },
      ];
    })
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

/** "3 projects", "1 project" or "No projects": what the bot owns, its home left out. */
export function botProjectsLabel(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<ListedProject>,
): string {
  const ownerOf = createProjectOwnerResolver(bots);
  const count = projects.filter(
    (project) => !project.isScratch && !project.isBotHome && ownerOf(project) === bot.key,
  ).length;
  return count === 0 ? "No projects" : `${count} project${count === 1 ? "" : "s"}`;
}

/** A manager's second line: its bot's name or No bot, and the environment when there are several. */
export function managerSubtitle(ownerName: string | null, environmentLabel: string | null): string {
  return [ownerName ?? "No bot", environmentLabel].filter(Boolean).join(" · ");
}
