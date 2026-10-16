import {
  OrchestratorMcpFailure,
  type RoleCreateInput,
  type RoleUpdateInput,
  type WorkflowCreateInput,
  type WorkflowReviseInput,
  workflowForwardStages,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CrewService } from "../../../crew/CrewService.ts";
import { crewThreadGrants } from "../../../crew/crewMcpCapabilities.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readCaller } from "../../threadAccess.ts";
import { WorkflowsToolkit } from "./tools.ts";

const GRANT = "crew.workflows";

const denied = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This bot can't manage workflows. A person can allow it with \"Manage workflows\" in the bot's Tools settings.",
});

/** The calling bot or crew thread's grants; undefined for every other caller. */
const callerGrants = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.thread === undefined ? Effect.undefined : crewThreadGrants(scope.thread.threadId),
  ),
);

/** Bot and crew threads need the grant to read the library; everyone else may. */
const checkRead = callerGrants.pipe(
  Effect.flatMap((grants) =>
    grants === undefined || grants.includes(GRANT) ? Effect.void : Effect.fail(denied),
  ),
);

/**
 * Bot and crew threads change the library with the grant a person gave the bot. Every other
 * caller needs full access, as for the t3_bot_* tools.
 */
const checkWrite = callerGrants.pipe(
  Effect.flatMap((grants) =>
    grants !== undefined
      ? grants.includes(GRANT)
        ? Effect.void
        : Effect.fail(denied)
      : readCaller().pipe(
          Effect.flatMap((caller) =>
            assertFullAccess(
              caller,
              "Changing workflows and roles needs a live full-access/default calling thread or a full-access client.",
            ),
          ),
        ),
  ),
);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Runs `effect` after `check`, passing service errors on as messages an agent can act on. */
const guarded =
  <EC, RC>(check: Effect.Effect<void, EC, RC>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    check.pipe(
      Effect.andThen(effect),
      Effect.mapError((error) =>
        isMcpFailure(error)
          ? error
          : invalid(error instanceof Error ? error.message : String(error)),
      ),
    );
const reading = guarded(checkRead);
const writing = guarded(checkWrite);

const make = Effect.gen(function* () {
  const workflows = yield* WorkflowService;
  const crew = yield* CrewService;
  return {
    t3_workflow_list: McpToolAccess.reads(() =>
      reading(workflows.listLatestDefinitions()).pipe(
        Effect.map((definitions) => ({
          workflows: definitions.map((definition) => ({
            id: definition.id,
            name: definition.name,
            revision: definition.revision,
            stages: workflowForwardStages(definition),
          })),
        })),
      ),
    ),
    t3_workflow_get: McpToolAccess.reads((input: { readonly id: string }) =>
      reading(
        workflows
          .getLatestDefinition(input.id)
          .pipe(
            Effect.flatMap((definition) =>
              definition === null
                ? Effect.fail(
                    invalid(`Workflow not found: ${input.id}. t3_workflow_list shows the library.`),
                  )
                : Effect.succeed(definition),
            ),
          ),
      ),
    ),
    t3_workflow_create: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowCreateInput.Type) =>
        writing(workflows.createDefinition(input.definition)),
    ),
    t3_workflow_update: McpToolAccess.writesWithCapability(
      (input: typeof WorkflowReviseInput.Type) =>
        writing(workflows.reviseDefinition(input.definition, input.expectedRevision)),
    ),
    t3_workflow_delete: McpToolAccess.writesWithCapability((input: { readonly id: string }) =>
      writing(workflows.deleteDefinition(input.id)).pipe(Effect.as({ deleted: true })),
    ),
    t3_role_list: McpToolAccess.reads(() =>
      reading(crew.listRoles()).pipe(Effect.map((roles) => ({ roles }))),
    ),
    t3_role_create: McpToolAccess.writesWithCapability((input: typeof RoleCreateInput.Type) =>
      writing(crew.createRole(input)),
    ),
    t3_role_update: McpToolAccess.writesWithCapability((input: typeof RoleUpdateInput.Type) =>
      writing(crew.updateRole(input)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(WorkflowsToolkit, make);
