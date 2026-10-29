import type { CREW_TOOL_GRANTS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import { McpSchema, type Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { BotsToolkit } from "./toolkits/bots/tools.ts";
import { CrewToolkit } from "./toolkits/crew/tools.ts";
import { FeaturesToolkit } from "./toolkits/features/tools.ts";
import { WorkflowsToolkit } from "./toolkits/workflows/tools.ts";

type Grant = (typeof CREW_TOOL_GRANTS)[number]["id"];

/**
 * What a crew thread needs from its run's grants: a grant, `"crew"` for any `crew.*` grant, or
 * `null` for none. `alsoPlain` tools are listed to every caller that isn't a crew thread too.
 */
type Needs = Grant | "crew" | null | { readonly alsoPlain: Grant };

/**
 * `McpSchema.EnabledWhen` reads only the MCP client profile, so read the caller from the request
 * fiber. Effect refuses a call to a tool it doesn't list, so this gates calls as well.
 */
const callerHolds = (needs: Needs): boolean => {
  const fiber = Fiber.getCurrent();
  const grants =
    fiber &&
    Context.getOrUndefined(fiber.context, McpInvocationContext.McpInvocationContext)?.crewGrants;
  if (grants === undefined) return typeof needs === "object" && needs !== null;
  if (needs === null) return true;
  if (needs === "crew") return grants.some((grant) => grant.startsWith("crew."));
  return grants.includes(typeof needs === "object" ? needs.alsoPlain : needs);
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
 * checks. Threads that aren't a crew member's, and outside clients, see only the feature-link
 * tools, so a thread a person started can become a feature and leave it again.
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
    crew_delegate: "crew.delegate",
    crew_respond: "crew.respond",
    crew_ask: "crew.ask",
    crew_list_handoffs: "crew.status",
    crew_wait_handoff: "crew.status",
    crew_answer: "crew.answer",
    crew_stage_handoff: "crew.respond",
    crew_list_projects: "crew.projects",
    crew_create_project: "crew.create-project",
    crew_link_issue: "crew",
    crew_list_issues: "crew",
    crew_create_todo: "crew",
    crew_read_todo: "crew",
    crew_update_todo: "crew",
  }),
  features: gated(FeaturesToolkit, {
    t3_feature_attach_thread: { alsoPlain: "crew.workflows" },
    t3_feature_detach_thread: { alsoPlain: "crew.workflows" },
  }),
  workflows: gated(WorkflowsToolkit, {
    t3_workflow_list: "crew.workflows",
    t3_workflow_get: "crew.workflows",
    t3_workflow_create: "crew.workflows",
    t3_workflow_update: "crew.workflows",
    t3_workflow_delete: "crew.workflows",
    t3_role_list: "crew.workflows",
    t3_role_create: "crew.workflows",
    t3_role_update: "crew.workflows",
    t3_feature_start: "crew.workflows",
  }),
};
