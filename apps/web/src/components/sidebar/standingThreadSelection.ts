import {
  createLogicalBotResolver,
  projectBotId,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import {
  headquartersBotId,
  headquartersProjectId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";

export type StandingThreadSelection =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | { readonly kind: "select"; readonly botKey: string; readonly projectKey: string | null };

/**
 * What an open standing thread implies for the rail: a bot's headquarters picks that bot; a
 * project manager picks the project's bot and scopes the thread list to the project. `pending`
 * until the bot or project it names has loaded.
 */
export function standingThreadSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly botId?: string | undefined;
  }>;
  readonly projectKeyOf: (environmentId: EnvironmentId, projectId: ProjectId) => string | null;
}): StandingThreadSelection {
  const { environmentId, threadId, bots } = input;
  const botId = headquartersBotId(threadId);
  if (botId !== null) {
    const bot = bots.find((candidate) =>
      candidate.members.some(
        (member) => member.environmentId === environmentId && member.botId === botId,
      ),
    );
    return bot ? { kind: "select", botKey: bot.key, projectKey: null } : { kind: "pending" };
  }
  const projectId = headquartersProjectId(threadId);
  if (projectId === null) return { kind: "none" };
  const project = input.projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const projectKey = project ? input.projectKeyOf(environmentId, projectId) : null;
  if (!project || projectKey === null) return { kind: "pending" };
  const ownerKey = createLogicalBotResolver(bots)(environmentId, projectBotId(project));
  return bots.some((bot) => bot.key === ownerKey)
    ? { kind: "select", botKey: ownerKey, projectKey }
    : { kind: "pending" };
}
