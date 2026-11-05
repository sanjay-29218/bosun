import {
  Bot,
  BotCreateInput,
  BotMoveProjectInput,
  BotReorderInput,
  BotUpdateInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  Project,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotProjectsResult, LinkBotProjects, LinkBotTask } from "./linkTools.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotService.BotService,
  ],
};

const List = Tool.make("t3_bot_list", {
  ...shared,
  description:
    "List an environment's bots in rail order. Each bot owns projects (a project's botId); Captain owns projects created without a bot.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({ bots: Schema.Array(Bot) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Create = Tool.make("t3_bot_create", {
  ...shared,
  description:
    "Create a bot at the end of the rail. Choose a stable id; retrying with the same id and fields returns the same bot. Without modelSelection it runs on this thread's model. Give it projects with t3_bot_move_project, or pass botId to t3_project_create.",
  parameters: BotCreateInput,
  success: Bot,
}).annotate(Tool.Idempotent, true);

const Update = Tool.make("t3_bot_update", {
  ...shared,
  description:
    "Change a bot's name, avatar, color, instructions, allowed tools, runtime mode, default model, default workflow or what its headquarters does when its conversation grows long. Omitted fields are kept. Pass the bot's current revision as expectedRevision.",
  parameters: BotUpdateInput,
  success: Bot,
});

const Delete = Tool.make("t3_bot_delete", {
  ...shared,
  description:
    "Delete a bot and the automations that run as it. Refused while it owns any project (move them with t3_bot_move_project first) and always for Captain.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ deleted: Schema.Boolean }),
}).annotate(Tool.Destructive, true);

const Reorder = Tool.make("t3_bot_reorder", {
  ...shared,
  description: "Set the rail order. botIds must list every bot exactly once.",
  parameters: BotReorderInput,
  success: Schema.Struct({ bots: Schema.Array(Bot) }),
}).annotate(Tool.Idempotent, true);

const MoveProject = Tool.make("t3_bot_move_project", {
  ...shared,
  description:
    "Give a project to another bot. Requests and features already running keep the bot that started them. With environmentId, projectId and botId are that environment's (t3_bot_list there).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotMoveProjectInput.fields,
  }),
  success: Project,
}).annotate(Tool.Idempotent, true);

const Projects = Tool.make("t3_bot_projects", {
  ...shared,
  description:
    "List a bot's projects on this environment and on every linked environment, where a bot with the same name (Captain: Captain) owns them. Default bot: the one whose headquarters calls. Each project names its environmentId and open features; each environment says whether it answered. Hand work to a project on another environment with delegate_task, target.environmentId and target.projectId.",
  parameters: Schema.Struct({
    botId: Schema.optional(
      Schema.String.annotate({ description: "This environment's bot (t3_bot_list id)." }),
    ),
  }),
  success: BotProjectsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const BotsToolkit = Toolkit.make(
  List,
  Create,
  Update,
  Delete,
  Reorder,
  MoveProject,
  Projects,
  LinkBotProjects,
  LinkBotTask,
);
