import type { ProjectId, WorkflowDefinition } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BotStore } from "../bots/BotStore.ts";
import { BotThreadRuntime } from "../bots/BotThreadRuntime.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import { validateWorkflowDefinition, WorkflowValidationError } from "./WorkflowGraph.ts";
import { WorkflowStore, type FeatureWorkflowCopy } from "./WorkflowStore.ts";

export interface WorkflowServiceShape {
  readonly createDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinition,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly reviseDefinition: (
    projectId: ProjectId,
    definition: WorkflowDefinition,
    expectedRevision: number,
  ) => Effect.Effect<WorkflowDefinition, WorkflowServiceError>;
  readonly copyForFeature: (
    featureId: string,
    projectId: ProjectId,
    workflowId: string,
  ) => Effect.Effect<FeatureWorkflowCopy, WorkflowServiceError>;
  readonly getFeatureCopy: WorkflowStore["Service"]["getFeatureCopy"];
  readonly getLatestDefinition: WorkflowStore["Service"]["getLatestDefinition"];
}

export type WorkflowServiceError =
  | WorkflowValidationError
  | PersistenceSqlError
  | ProjectionRepositoryError;

export class WorkflowService extends Context.Service<WorkflowService, WorkflowServiceShape>()(
  "t3/workflows/WorkflowService",
) {}

const validId = (value: string) => value.trim().length > 0 && value.length <= 128;

export const WorkflowServiceLive = Layer.effect(
  WorkflowService,
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const bots = yield* BotStore;
    const runtime = yield* BotThreadRuntime;

    const checkDefinition = (projectId: ProjectId, definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => validateWorkflowDefinition(definition),
          catch: (cause) =>
            cause instanceof WorkflowValidationError
              ? cause
              : new WorkflowValidationError("Invalid workflow definition"),
        });
        if (!(yield* runtime.projectExists(projectId))) {
          return yield* Effect.fail(new WorkflowValidationError("Project does not exist"));
        }
        const templateIds = new Set<string>();
        for (const step of definition.steps) {
          if (step.kind === "bot") templateIds.add(step.templateId);
          if (step.kind === "decision" && step.approver.kind === "bot") {
            templateIds.add(step.approver.templateId);
          }
        }
        for (const templateId of templateIds) {
          const template = yield* bots.getTemplate(templateId);
          if (
            !template?.enabled ||
            !template.autoCreateForFeature ||
            (template.projectId !== null && template.projectId !== projectId)
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError(`Feature bot template is unavailable: ${templateId}`),
            );
          }
        }
      });

    return WorkflowService.of({
      createDefinition: (projectId, definition) =>
        Effect.gen(function* () {
          if (definition.revision !== 1) {
            return yield* Effect.fail(
              new WorkflowValidationError("New workflows start at revision 1"),
            );
          }
          yield* checkDefinition(projectId, definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (!(yield* store.createDefinition(projectId, definition, createdAt))) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow ID is already in use"));
          }
          return definition;
        }),
      reviseDefinition: (projectId, definition, expectedRevision) =>
        Effect.gen(function* () {
          if (
            !Number.isSafeInteger(expectedRevision) ||
            expectedRevision < 1 ||
            definition.revision !== expectedRevision + 1
          ) {
            return yield* Effect.fail(new WorkflowValidationError("Invalid workflow revision"));
          }
          yield* checkDefinition(projectId, definition);
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (
            !(yield* store.updateDefinition(projectId, definition, expectedRevision, createdAt))
          ) {
            return yield* Effect.fail(
              new WorkflowValidationError("Workflow changed; reload and retry"),
            );
          }
          return definition;
        }),
      copyForFeature: (featureId, projectId, workflowId) =>
        Effect.gen(function* () {
          if (!validId(featureId) || !validId(workflowId)) {
            return yield* Effect.fail(
              new WorkflowValidationError("Invalid feature or workflow ID"),
            );
          }
          const existing = yield* store.getFeatureCopy(featureId);
          if (existing !== null) {
            if (existing.projectId !== projectId || existing.definition.id !== workflowId) {
              return yield* Effect.fail(
                new WorkflowValidationError("Feature is attached to another workflow"),
              );
            }
            return existing;
          }
          const definition = yield* store.getLatestDefinition(projectId, workflowId);
          if (definition === null) {
            return yield* Effect.fail(new WorkflowValidationError("Workflow does not exist"));
          }
          yield* checkDefinition(projectId, definition);
          const copy = yield* store.copyForFeature(
            featureId,
            projectId,
            workflowId,
            definition.revision,
            DateTime.formatIso(yield* DateTime.now),
          );
          if (copy === null || copy.projectId !== projectId || copy.definition.id !== workflowId) {
            return yield* Effect.fail(
              new WorkflowValidationError("Feature is attached to another workflow"),
            );
          }
          return copy;
        }),
      getFeatureCopy: store.getFeatureCopy,
      getLatestDefinition: store.getLatestDefinition,
    });
  }),
);
