import {
  Bot,
  BotCreateInput,
  BotDeleteInput,
  BotMoveProjectInput,
  BotReorderInput,
  BotSetPinInput,
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
import {
  BotProjectsResult,
  LinkBotImport,
  LinkBotNotices,
  LinkLibrary,
  LinkLibrarySync,
  LinkBotProjects,
  LinkBotRehome,
  LinkBotTask,
  ListedBot,
} from "./linkTools.ts";

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
    "List an environment's bots in rail order; there may be none. Each bot owns projects (a project's botId); a project with a null botId has no bot. Each bot names its home environment and the linked environments it works on (permittedEnvironments): every one linked to its home.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({ bots: Schema.Array(ListedBot) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Create = Tool.make("t3_bot_create", {
  ...shared,
  description:
    "Create a bot at the end of the rail. Choose a stable id; retrying with the same id and fields returns the same bot. Without modelSelection it runs on this thread's model. It gets every tool, with full access. Give it projects with t3_bot_move_project, or pass botId to t3_project_create.",
  parameters: BotCreateInput,
  success: Bot,
}).annotate(Tool.Idempotent, true);

const Update = Tool.make("t3_bot_update", {
  ...shared,
  description:
    "Change a bot's name, avatar, color, instructions or default model. Omitted fields are kept. Pass the bot's current revision as expectedRevision.",
  parameters: BotUpdateInput,
  success: Bot,
});

const Delete = Tool.make("t3_bot_delete", {
  ...shared,
  description:
    "Delete a bot and the automations that run as it. Refused while it owns any project: unlink each first with t3_bot_move_project (botId null, or another bot).",
  parameters: BotDeleteInput,
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
    "Give a project to another bot, or botId null for no bot. Requests and features already running keep the bot that started them. With environmentId, projectId and botId are that environment's (t3_bot_list there).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: BotMoveProjectInput.fields.projectId,
    botId: BotMoveProjectInput.fields.botId,
  }),
  success: Project,
}).annotate(Tool.Idempotent, true);

const Pin = Tool.make("t3_bot_pin", {
  ...shared,
  description:
    "Pin a bot (botId) or a project's manager (projectId) to the person's main rail, or unpin it with pinned false. Every bot and manager stays listed under Bots either way.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotSetPinInput.fields,
  }),
  success: Schema.Struct({ pinned: Schema.Boolean }),
}).annotate(Tool.Idempotent, true);

const Projects = Tool.make("t3_bot_projects", {
  ...shared,
  description:
    "List a bot's projects here and on linked environments that gave them to it (default: the calling headquarters' bot; from a project's manager, its project and its copies there), each with its environmentId and open features. Each environment says whether it answered and lists the bot's requests waiting for it, which start once it answers. Hand work to a project on another environment with t3_project_send or delegate_task and its environmentId.",
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
  Pin,
  Projects,
  LinkBotProjects,
  LinkBotTask,
  LinkBotNotices,
  LinkLibrary,
  LinkLibrarySync,
  LinkBotImport,
  LinkBotRehome,
);
