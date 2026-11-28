import { isStandingThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, type Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { BotsToolkit } from "./toolkits/bots/tools.ts";
import {
  READ_MANAGER_INSTRUCTIONS,
  UPDATE_MANAGER_INSTRUCTIONS,
} from "./toolkits/crew/managerInstructionsTools.ts";
import { CrewToolkit } from "./toolkits/crew/tools.ts";
import { FeaturesToolkit } from "./toolkits/features/tools.ts";
import { ProjectRequestsToolkit } from "./toolkits/projectRequests/tools.ts";

/**
 * Which thread callers a tool is listed to. Every thread gets `thread` tools, the same for a plain
 * task, a bot or a crew member. `crew` ones go to the crew thread acting for a run, `standing`
 * ones to a bot's headquarters and projects' managers, `member` ones to a feature's crew members,
 * and `linkOnly` ones to linked environments alone.
 */
type Needs = "thread" | "crew" | "standing" | "member" | "linkOnly";

/**
 * `McpSchema.EnabledWhen` reads only the MCP client profile, so read the caller from the request
 * fiber. Effect refuses a call to a tool it doesn't list, so this gates calls as well. A linked
 * environment's session sees the tools its bots use here; the environment it calls from already
 * checked its own caller, and the handler checks the link's access.
 */
const callerHolds = (needs: Needs, forLinks: boolean): boolean => {
  const fiber = Fiber.getCurrent();
  const scope =
    fiber && Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext);
  if (scope?.client?.linked === true) return forLinks;
  const thread = scope?.thread;
  if (thread === undefined || needs === "linkOnly") return false;
  switch (needs) {
    case "thread":
      return true;
    case "crew":
      return scope?.capabilities.has("crew") === true;
    case "standing":
      return thread.subagent !== true && isStandingThread(thread.threadId);
    case "member":
      return scope?.featureCrewMember === true;
  }
};

const gated = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  grants: { readonly [Name in keyof Tools]: Needs },
  forLinks: ReadonlyArray<keyof Tools> = [],
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) => {
      const enabled = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
      const needs = grants[tool.name as keyof Tools];
      const linked = needs === "linkOnly" || forLinks.includes(tool.name as keyof Tools);
      return tool.annotate(
        McpSchema.EnabledWhen,
        (client) => callerHolds(needs, linked) && (enabled?.(client) ?? true),
      );
    }),
  ) as unknown as Toolkit.Toolkit<Tools>;

/** Bosun's toolkits, each tool listed to the thread callers it acts for. */
export const CrewGatedToolkits = {
  bots: gated(
    BotsToolkit,
    {
      t3_bot_list: "thread",
      t3_bot_create: "thread",
      t3_bot_update: "thread",
      t3_bot_delete: "thread",
      t3_bot_reorder: "thread",
      t3_bot_move_project: "thread",
      t3_bot_pin: "thread",
      t3_bot_projects: "thread",
      t3_bot_link_projects: "linkOnly",
      t3_bot_link_task: "linkOnly",
      t3_bot_link_notices: "linkOnly",
      t3_crew_link_library: "linkOnly",
      t3_crew_link_library_sync: "linkOnly",
      t3_bot_link_import: "linkOnly",
      t3_bot_link_rehome: "linkOnly",
    },
    ["t3_bot_list", "t3_bot_move_project"],
  ),
  crew: gated(CrewToolkit, {
    crew_ask_person: "member",
    crew_link_issue: "crew",
    crew_list_issues: "crew",
    crew_create_todo: "crew",
    crew_read_todo: "crew",
    crew_update_todo: "crew",
    crew_create_milestone: "crew",
    crew_update_milestone: "crew",
    [READ_MANAGER_INSTRUCTIONS]: "standing",
    [UPDATE_MANAGER_INSTRUCTIONS]: "standing",
  }),
  features: gated(FeaturesToolkit, {
    t3_role_list: "thread",
    t3_role_create: "thread",
    t3_role_update: "thread",
    t3_feature_workflow_create: "thread",
    t3_feature_workflow_update: "thread",
    t3_library_import: "thread",
    t3_feature_start: "thread",
    t3_feature_finish: "thread",
    t3_feature_list: "thread",
  }),
  projectRequests: gated(ProjectRequestsToolkit, {
    t3_project_send: "thread",
    t3_project_requests: "thread",
    t3_project_reply: "thread",
  }),
};
