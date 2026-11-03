import {
  BotOperationError,
  CrewOperationError,
  BosunWsRpcGroup,
  FeatureOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { BotService } from "./bots/BotService.ts";
import type { CrewService } from "./crew/CrewService.ts";
import type { FeatureService } from "./features/FeatureService.ts";
import type { IssueService } from "./issues/IssueService.ts";
import type { TicketService } from "./tickets/TicketService.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";

export interface BosunWsServices {
  readonly bots: BotService["Service"];
  readonly crew: CrewService["Service"];
  readonly features: FeatureService["Service"];
  readonly issues: IssueService["Service"];
  readonly tickets: TicketService["Service"];
}

/**
 * Handlers for Bosun's features, roles and crew RPCs, merged with the T3
 * handlers in `ws.ts`. A separate group keeps the T3 handler map within the
 * type checker's instantiation depth and keeps upstream merges cheap.
 */
export const layerBosunWsRpc = ({ bots, crew, features, issues, tickets }: BosunWsServices) =>
  BosunWsRpcGroup.middleware(RpcInstrumentation).toLayer(
    Effect.sync(() => {
      return {
        [WS_METHODS.featuresSetStatus]: (input) =>
          features
            .setStatus(input.featureId, input.projectId, input.status)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresCreate]: (input) =>
          features
            .create(input)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresList]: (input) =>
          features
            .listByProject(input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresBoard]: (input) =>
          features
            .board(input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        // The issue and ticket services already fail with the transport's errors.
        [WS_METHODS.issuesList]: (input) => issues.list(input.projectId),
        [WS_METHODS.issuesGet]: (input) => issues.get(input.projectId, input.number),
        [WS_METHODS.issuesCreate]: (input) => issues.create(input),
        [WS_METHODS.issuesSetState]: (input) => issues.setState(input),
        [WS_METHODS.ticketsList]: (input) => tickets.list(input.projectId),
        [WS_METHODS.ticketsCreate]: (input) => tickets.create(input),
        [WS_METHODS.ticketsUpdate]: (input) => tickets.update(input),
        [WS_METHODS.ticketsDelete]: (input) => tickets.remove(input.projectId, input.ticketId),
        [WS_METHODS.ticketsMoveToIssue]: (input) =>
          tickets.moveToIssue(input.projectId, input.ticketId),
        [WS_METHODS.featuresGet]: (input) =>
          features.get(input.featureId).pipe(
            Effect.map((feature) => (feature?.projectId === input.projectId ? feature : null)),
            Effect.mapError((error) => new FeatureOperationError({ reason: String(error) })),
          ),
        [WS_METHODS.featuresStart]: (input) =>
          features
            .start(input.featureId, input.projectId)
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.featuresSetIssue]: (input) =>
          features
            .setIssue({ id: input.featureId, projectId: input.projectId, url: input.url })
            .pipe(Effect.mapError((error) => new FeatureOperationError({ reason: String(error) }))),
        [WS_METHODS.botsList]: () =>
          bots.list.pipe(
            Effect.mapError((error) => new BotOperationError({ reason: error.message })),
          ),
        [WS_METHODS.botsCreate]: (input) =>
          bots
            .create(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsUpdate]: (input) =>
          bots
            .update(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsDelete]: (input) =>
          bots
            .delete(input.id)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsReorder]: (input) =>
          bots
            .reorder(input.botIds)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsMoveProject]: (input) =>
          bots
            .moveProject(input)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.botsOpenHeadquarters]: (input) =>
          crew.ensureHeadquarters(input.botId).pipe(
            Effect.map((run) => ({ threadId: run.threadId })),
            Effect.mapError((error) => new BotOperationError({ reason: String(error) })),
          ),
        [WS_METHODS.botsStartNewSession]: (input) =>
          crew
            .startNewSession(input.botId)
            .pipe(Effect.mapError((error) => new BotOperationError({ reason: error.message }))),
        [WS_METHODS.rolesList]: () =>
          crew
            .listRoles()
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.rolesCreate]: (input) =>
          crew
            .createRole(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.rolesUpdate]: (input) =>
          crew
            .updateRole(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsList]: () =>
          crew
            .listWorkflows()
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsCreate]: (input) =>
          crew
            .createWorkflow(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsUpdate]: (input) =>
          crew
            .updateWorkflow(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.workflowsDelete]: (input) =>
          crew
            .deleteWorkflow(input.id)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewConfiguration]: (input) =>
          crew
            .projectConfiguration(input.projectId)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewInitialize]: (input) =>
          crew
            .ensureDefaults(input.modelSelection)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewInstantiate]: (input) =>
          crew
            .instantiate(input.id, input.projectId, input.roleId)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewSetHierarchy]: (input) =>
          crew
            .placeInProject(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewSetDelegation]: (input) =>
          crew
            .setDelegationInProject(input)
            .pipe(Effect.mapError((error) => new CrewOperationError({ reason: String(error) }))),
        [WS_METHODS.crewStart]: (input) =>
          crew.startRequest(input).pipe(
            Effect.map((run) => ({ runId: run.id, threadId: run.threadId })),
            Effect.mapError((error) => new CrewOperationError({ reason: String(error) })),
          ),
      };
    }),
  );
