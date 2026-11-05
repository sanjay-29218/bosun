import {
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  RunId,
  RuntimeMode,
  ThreadId,
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
    }),
  ),
  projects: Schema.Array(BotProject),
});
export type BotProjectsResult = typeof BotProjectsResult.Type;

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
    "The projects here whose owner is the same bot as the calling environment's (`botKey`), with their open features.",
  parameters: Schema.Struct({ botKey: Schema.String }),
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
    botKey: Schema.String,
    botName: Schema.String,
    task: Schema.String,
    title: Schema.String,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    clientRequestId: Schema.String,
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, false);
