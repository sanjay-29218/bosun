import {
  Bot,
  EnvironmentId,
  ModelSelection,
  NodeId,
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  RuntimeMode,
  ThreadId,
  WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** One project a bot owns, on the environment that names it. */
export const BotProject = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  botId: Schema.String,
  openFeatures: Schema.Array(Schema.Struct({ featureId: Schema.String, title: Schema.String })),
});
export type BotProject = typeof BotProject.Type;

export const BotProjectsResult = Schema.Struct({
  bot: Schema.Struct({ id: Schema.String, name: Schema.String }),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      here: Schema.Boolean,
      reachable: Schema.Boolean,
      lastReachedAt: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      waiting: Schema.Array(
        Schema.Struct({ taskId: NodeId, projectId: ProjectId, title: Schema.String }),
      ).annotate({
        description: "This bot's requests that wait for the environment to answer, then start.",
      }),
    }),
  ),
  projects: Schema.Array(BotProject),
});
export type BotProjectsResult = typeof BotProjectsResult.Type;

const EnvironmentName = { environmentId: EnvironmentId, label: Schema.String };

/** A bot with where it lives and the linked environments it may start work on. */
export const ListedBot = Schema.Struct({
  ...Bot.fields,
  home: Schema.Struct(EnvironmentName).annotate({
    description: "The environment the bot lives on: its settings, chat, memory and home folder.",
  }),
  permittedEnvironments: Schema.Array(
    Schema.Struct({ ...EnvironmentName, reachable: Schema.Boolean }),
  ).annotate({
    description:
      "Linked environments the bot may start work on; reachable says whether the link answered last time.",
  }),
});
export type ListedBot = typeof ListedBot.Type;

/** The calling environment's bot, as it names itself; it owns projects here by `remoteBot`. */
export const BotHome = Schema.Struct({
  environmentId: EnvironmentId,
  botId: Schema.String,
  botName: Schema.String,
  label: Schema.String,
});
export type BotHome = typeof BotHome.Type;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

/**
 * Tools only a linked environment calls, for its bot's work here. Agents never see them:
 * `crewToolGrants.ts` lists them to link sessions alone.
 */
export const LinkBotProjects = Tool.make("t3_bot_link_projects", {
  ...shared,
  description:
    "The projects here owned by the calling environment's bot (`home`), with their open features.",
  parameters: Schema.Struct({ home: BotHome }),
  success: Schema.Struct({ projects: Schema.Array(BotProject) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LinkBotTask = Tool.make("t3_bot_link_task", {
  ...shared,
  description:
    "Starts a request from the calling environment's bot headquarters as this project's manager, in a new worktree.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    home: BotHome,
    task: Schema.String,
    title: Schema.String,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    clientRequestId: Schema.String,
    /** The workflow a feature for this request runs on, by value. */
    workflow: Schema.optional(WorkflowSnapshot),
    /**
     * Starts nothing: cancels the run an earlier call with this key left queued, and returns its
     * thread if it started; fails `run_not_found` when none runs.
     */
    cancelIfStarted: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, false);
