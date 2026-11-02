import {
  Bot,
  BotCreateInput,
  BotMoveProjectInput,
  BotReorderInput,
  BotUpdateInput,
  OrchestratorMcpFailure,
  Project,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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
    "List this environment's bots in rail order. Each bot owns projects (a project's botId); Captain owns projects created without a bot.",
  success: Schema.Struct({ bots: Schema.Array(Bot) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Create = Tool.make("t3_bot_create", {
  ...shared,
  description:
    "Create a bot at the end of the rail. Choose a stable id; retrying with the same id and fields returns the same bot. Give it projects with t3_bot_move_project, or pass botId to t3_project_create.",
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
    "Give a project to another bot. Requests and features already running keep the bot that started them.",
  parameters: BotMoveProjectInput,
  success: Project,
}).annotate(Tool.Idempotent, true);

export const BotsToolkit = Toolkit.make(List, Create, Update, Delete, Reorder, MoveProject);
