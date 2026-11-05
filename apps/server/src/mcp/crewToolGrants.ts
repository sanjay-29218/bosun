import type { CREW_TOOL_GRANTS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, type Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { BotsToolkit } from "./toolkits/bots/tools.ts";
import { CrewToolkit } from "./toolkits/crew/tools.ts";
import { FeaturesToolkit } from "./toolkits/features/tools.ts";
import { ProjectReplyToolkit } from "./toolkits/projectRequests/tools.ts";

type Grant = (typeof CREW_TOOL_GRANTS)[number]["id"];

/**
 * What a crew thread needs from its run's grants: a grant, or `null` for none. Callers that
 * aren't crew threads see none of these tools.
 */
type Needs = Grant | null;

/**
 * `McpSchema.EnabledWhen` reads only the MCP client profile, so read the caller from the request
 * fiber. Effect refuses a call to a tool it doesn't list, so this gates calls as well.
 */
const callerHolds = (needs: Needs): boolean => {
  const fiber = Fiber.getCurrent();
  const grants =
    fiber &&
    Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)?.crewGrants;
  if (grants === undefined) return false;
  if (needs === null) return true;
  return grants.includes(needs);
};

const gated = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  grants: { readonly [Name in keyof Tools]: Needs },
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) => {
      const enabled = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
      const needs = grants[tool.name as keyof Tools];
      return tool.annotate(
        McpSchema.EnabledWhen,
        (client) => callerHolds(needs) && (enabled?.(client) ?? true),
      );
    }),
  ) as unknown as Toolkit.Toolkit<Tools>;

/**
 * Bosun's toolkits, each tool listed only to crew threads whose run holds the grant its handler
 * checks.
 */
export const CrewGatedToolkits = {
  bots: gated(BotsToolkit, {
    t3_bot_list: null,
    t3_bot_create: "crew.workflows",
    t3_bot_update: "crew.workflows",
    t3_bot_delete: "crew.workflows",
    t3_bot_reorder: "crew.workflows",
    t3_bot_move_project: "crew.workflows",
  }),
  crew: gated(CrewToolkit, {
    crew_link_issue: null,
    crew_list_issues: null,
    crew_create_todo: null,
    crew_read_todo: null,
    crew_update_todo: null,
  }),
  features: gated(FeaturesToolkit, {
    t3_role_list: "crew.workflows",
    t3_role_create: "crew.workflows",
    t3_role_update: "crew.workflows",
    t3_feature_workflow_create: "crew.workflows",
    t3_feature_workflow_update: "crew.workflows",
    t3_feature_start: null,
    t3_feature_finish: null,
    t3_feature_list: null,
  }),
  projectReplies: gated(ProjectReplyToolkit, { t3_project_reply: null }),
};
