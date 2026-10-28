import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  headquartersBotId,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";

import { createLogicalBotResolver, projectBotId, type LogicalBot } from "./botRail.ts";
import type { BotOwnedProject } from "./crewBoard.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

export interface EnvironmentScheduledTasks {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<ScheduledTask>;
}

/** Scheduled tasks are environment-local, so their ids only mean something with the environment. */
export const automationKey = (environmentId: EnvironmentId, taskId: string) =>
  `${environmentId}:${taskId}`;

export interface AutomationEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

export interface AutomationGroup {
  readonly key: string;
  /** Null when the rail doesn't know the owning bot, such as on a server without bots. */
  readonly bot: LogicalBot | null;
  readonly entries: ReadonlyArray<AutomationEntry>;
}

/**
 * Tasks grouped under the bot that owns them, in rail order. A task that runs as a bot, or posts
 * into a bot's headquarters, belongs to that bot; otherwise its project's bot does. Groups sort
 * their tasks by title.
 */
export function groupAutomationsByBot(input: {
  readonly environments: ReadonlyArray<EnvironmentScheduledTasks>;
  readonly projects: ReadonlyArray<BotOwnedProject>;
  readonly bots: ReadonlyArray<LogicalBot>;
}): AutomationGroup[] {
  const resolveBot = createLogicalBotResolver(input.bots);
  const projectBot = new Map(
    input.projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      projectBotId(project),
    ]),
  );
  const entriesByBot = new Map<string, AutomationEntry[]>();
  for (const { environmentId, tasks } of input.environments) {
    for (const task of tasks) {
      const botId =
        task.botId ??
        (task.threadId === null ? undefined : headquartersBotId(task.threadId)) ??
        projectBot.get(`${environmentId}:${task.projectId}`) ??
        CAPTAIN_BOT_ID;
      const botKey = resolveBot(environmentId, botId);
      const entries = entriesByBot.get(botKey) ?? [];
      entries.push({ key: automationKey(environmentId, task.id), environmentId, task });
      entriesByBot.set(botKey, entries);
    }
  }
  const byTitle = (left: AutomationEntry, right: AutomationEntry) =>
    left.task.title.localeCompare(right.task.title) || left.key.localeCompare(right.key);
  const groups: AutomationGroup[] = [];
  for (const bot of input.bots) {
    const entries = entriesByBot.get(bot.key);
    if (entries === undefined) continue;
    entriesByBot.delete(bot.key);
    groups.push({ key: bot.key, bot, entries: entries.sort(byTitle) });
  }
  const unowned = [...entriesByBot.values()].flat();
  if (unowned.length > 0) {
    groups.push({ key: "unowned", bot: null, entries: unowned.sort(byTitle) });
  }
  return groups;
}

export type AutomationRunShell = Parameters<typeof isThreadWorking>[0] &
  Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "projectId" | "title" | "createdAt" | "latestRun"
  >;

const runIndexKey = (environmentId: EnvironmentId, projectId: string, title: string) =>
  `${environmentId}:${projectId}:${title}`;

/** The thread a task posts every run into: the bot's headquarters or its bound thread. */
export function automationRunThreadId(
  task: Pick<ScheduledTask, "botId" | "threadId">,
): ThreadId | null {
  return task.botId === undefined ? task.threadId : botHeadquartersThreadId(task.botId);
}

/**
 * Finds the threads a task's runs went to. A task that runs as a bot posts every run into its
 * headquarters, and a task bound to a thread into that thread. Otherwise each run starts a thread in the task's project titled after the task, so runs are
 * matched by project and title; a thread renamed since, or a task renamed since, drops out.
 */
export function createAutomationRunIndex<Shell extends AutomationRunShell>(
  shells: ReadonlyArray<Shell>,
) {
  const byId = new Map<string, Shell>();
  const byTitle = new Map<string, Shell[]>();
  for (const shell of shells) {
    byId.set(`${shell.environmentId}:${shell.id}`, shell);
    const key = runIndexKey(shell.environmentId, shell.projectId, shell.title);
    const matches = byTitle.get(key) ?? [];
    matches.push(shell);
    byTitle.set(key, matches);
  }
  /** The task's run threads, newest first. */
  return (environmentId: EnvironmentId, task: ScheduledTask): Shell[] => {
    const boundThreadId = automationRunThreadId(task);
    if (boundThreadId !== null) {
      const bound = byId.get(`${environmentId}:${boundThreadId}`);
      return bound === undefined ? [] : [bound];
    }
    return (byTitle.get(runIndexKey(environmentId, task.projectId, task.title)) ?? [])
      .filter((shell) => shell.createdAt >= task.createdAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  };
}

/**
 * Whether a run is going now: the server is dispatching it, or the thread its last run went to
 * is still working on a run requested since. A bound thread working on something the user sent
 * before the task last fired doesn't count.
 */
export function isAutomationRunning(
  task: ScheduledTask,
  runThreads: ReadonlyArray<AutomationRunShell>,
): boolean {
  if (task.lastRunStatus === "running") return true;
  const latest = runThreads[0];
  if (latest === undefined || task.lastRunAt === null || !isThreadWorking(latest)) return false;
  const requestedAt = latest.latestRun?.requestedAt ?? latest.latestRun?.startedAt ?? null;
  return requestedAt !== null && requestedAt >= task.lastRunAt;
}

/** Keys of the tasks running now, across environments. */
export function runningAutomationKeys(
  environments: ReadonlyArray<EnvironmentScheduledTasks>,
  shells: ReadonlyArray<AutomationRunShell>,
): ReadonlySet<string> {
  const runThreads = createAutomationRunIndex(shells);
  const running = new Set<string>();
  for (const { environmentId, tasks } of environments) {
    for (const task of tasks) {
      if (isAutomationRunning(task, runThreads(environmentId, task))) {
        running.add(automationKey(environmentId, task.id));
      }
    }
  }
  return running;
}

/**
 * The last run failed and nobody has opened the task since. `seenFailedRunAt` is the
 * `lastRunAt` of the failure last seen, so a newer failure reads as unseen again.
 */
export function isAutomationFailureUnseen(
  task: Pick<ScheduledTask, "lastRunStatus" | "lastRunAt">,
  seenFailedRunAt: string | undefined,
): boolean {
  return task.lastRunStatus === "failed" && task.lastRunAt !== seenFailedRunAt;
}

/** Whether any task has a failure nobody has seen; `seen` is keyed by `automationKey`. */
export function hasUnseenAutomationFailure(
  environments: ReadonlyArray<EnvironmentScheduledTasks>,
  seen: Readonly<Record<string, string>>,
): boolean {
  return environments.some(({ environmentId, tasks }) =>
    tasks.some((task) =>
      isAutomationFailureUnseen(task, seen[automationKey(environmentId, task.id)]),
    ),
  );
}

/**
 * The sentence a bot's delete confirmation adds for the automations that run as it, which are
 * deleted with it, or null when it has none.
 */
export function botAutomationsDeleteWarning(
  tasks: ReadonlyArray<Pick<ScheduledTask, "botId">>,
  botId: string,
): string | null {
  const count = tasks.filter((task) => task.botId === botId).length;
  if (count === 0) return null;
  return `Its ${count} ${count === 1 ? "automation" : "automations"} will be deleted too.`;
}
