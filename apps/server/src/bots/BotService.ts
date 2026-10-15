import {
  BOT_DISPATCH_STATE,
  BOT_TURN_STATE,
  ThreadId,
  type BotTurnState,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  BotStore,
  type BotDefinition,
  type BotHierarchyNode,
  type BotTemplate,
  type BotRun,
  type BotRunSummary,
} from "./BotStore.ts";
import { BotThreadRuntime } from "./BotThreadRuntime.ts";

export class BotValidationError extends Error {
  readonly _tag = "BotValidationError";
}

export interface CreateBotDefinitionInput {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly featureId?: string | null;
  readonly templateId?: string | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface CreateBotTemplateInput {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly autoCreateForFeature?: boolean;
}

export interface UpdateBotTemplateInput extends CreateBotTemplateInput {
  readonly expectedRevision: number;
  readonly enabled: boolean;
}

export interface CreateBotRunInput {
  readonly id: string;
  readonly botId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
  readonly modelSelection?: ModelSelection;
}

export interface BotRunView {
  readonly run: BotRun;
  readonly turnState: BotTurnState;
  readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
}

export interface BotServiceShape {
  readonly ensureCrew: (
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) => Effect.Effect<ReadonlyArray<BotDefinition>, BotServiceError>;
  readonly createDefinition: (
    input: CreateBotDefinitionInput,
  ) => Effect.Effect<BotDefinition, BotServiceError>;
  readonly createTemplate: (
    input: CreateBotTemplateInput,
  ) => Effect.Effect<BotTemplate, BotServiceError>;
  readonly updateTemplate: (
    input: UpdateBotTemplateInput,
  ) => Effect.Effect<BotTemplate, BotServiceError>;
  readonly getDefinition: (id: string) => Effect.Effect<BotDefinition | null, PersistenceSqlError>;
  readonly getTemplate: (id: string) => Effect.Effect<BotTemplate | null, PersistenceSqlError>;
  readonly listTemplatesForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotTemplate>, PersistenceSqlError>;
  readonly instantiate: (
    id: string,
    projectId: ProjectId,
    templateId: string,
  ) => Effect.Effect<BotDefinition, BotServiceError>;
  readonly allowDelegation: (
    sourceBotId: string,
    targetBotId: string,
  ) => Effect.Effect<void, BotServiceError>;
  readonly revokeDelegation: (
    sourceBotId: string,
    targetBotId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listDelegationGrantsForProject: BotStore["Service"]["listDelegationGrantsForProject"];
  readonly listHierarchyForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotHierarchyNode>, PersistenceSqlError>;
  readonly setHierarchyParent: (
    botId: string,
    parentBotId: string | null,
    position?: number,
  ) => Effect.Effect<void, BotServiceError>;
  readonly createRun: (input: CreateBotRunInput) => Effect.Effect<BotRun, BotServiceError>;
  readonly getRun: (
    id: string,
  ) => Effect.Effect<BotRunView | null, PersistenceSqlError | ProjectionRepositoryError>;
  readonly listRunSummaries: (
    projectId: ProjectId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<BotRunSummary>, PersistenceSqlError>;
  readonly reconcileRuns: () => Effect.Effect<void, PersistenceSqlError>;
}

export type BotServiceError =
  | BotValidationError
  | PersistenceSqlError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export class BotService extends Context.Service<BotService, BotServiceShape>()(
  "t3/bots/BotService",
) {}

const nonEmpty = (value: string, field: string, limit: number) => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) {
    throw new BotValidationError(`${field} must contain 1-${limit} characters`);
  }
  return trimmed;
};

const sameRunRequest = (run: BotRun, input: CreateBotRunInput) =>
  run.botId === input.botId &&
  run.projectId === input.projectId &&
  run.taskText === input.taskText &&
  (input.modelSelection === undefined ||
    JSON.stringify(run.modelSelection) === JSON.stringify(input.modelSelection));

export const BotServiceLive = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const store = yield* BotStore;
    const runtime = yield* BotThreadRuntime;

    const threadInput = (run: BotRun) => ({
      runId: run.id,
      botId: run.botId,
      threadId: run.threadId,
      projectId: run.projectId,
      title: run.title,
      prompt: `${run.instructions}\n\nTask:\n${run.taskText}`,
      modelSelection: run.modelSelection,
      runtimeMode: run.runtimeMode,
      createdAt: run.createdAt,
    });

    const markDispatched = (
      run: BotRun,
      effect: Effect.Effect<void, OrchestrationDispatchError | PersistenceSqlError>,
    ) =>
      effect.pipe(
        Effect.flatMap(() =>
          DateTime.now.pipe(
            Effect.flatMap((now) => store.markStarted(run.id, DateTime.formatIso(now))),
          ),
        ),
        Effect.tapError(() =>
          store.markDispatchError(run.id, "Thread dispatch failed; retry pending"),
        ),
      );

    const dispatch = (run: BotRun) => markDispatched(run, runtime.start(threadInput(run)));
    const replayPending = (run: BotRun) =>
      store
        .nextRecoveryAttempt(run.id)
        .pipe(
          Effect.flatMap((attempt) =>
            markDispatched(run, runtime.replayPending(threadInput(run), attempt)).pipe(
              Effect.result,
              Effect.asVoid,
            ),
          ),
        );

    const createDefinition: BotServiceShape["createDefinition"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Bot ID", 128),
          catch: () => new BotValidationError("Invalid bot ID"),
        });
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Bot name", 200),
          catch: () => new BotValidationError("Invalid bot name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Bot instructions", 16_000),
          catch: () => new BotValidationError("Invalid bot instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => {
            const tools = input.allowedTools ?? [];
            if (tools.length > 32) throw new BotValidationError("Too many tools");
            return [...new Set(tools.map((tool) => nonEmpty(tool, "Tool", 100)))];
          },
          catch: () => new BotValidationError("Invalid tool grants"),
        });
        const featureId = input.featureId ?? null;
        const templateId = input.templateId ?? null;
        if (featureId !== null && input.projectId === null) {
          return yield* Effect.fail(new BotValidationError("A feature bot needs a project"));
        }
        const template = templateId === null ? null : yield* store.getTemplate(templateId);
        if (templateId !== null && (!template || !template.enabled)) {
          return yield* Effect.fail(new BotValidationError("Source template is unavailable"));
        }
        if (template && template.projectId !== null && template.projectId !== input.projectId) {
          return yield* Effect.fail(new BotValidationError("Template belongs to another project"));
        }
        if (input.projectId !== null && !(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new BotValidationError("Project does not exist"));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const definition: BotDefinition = {
          ...input,
          id,
          featureId,
          templateId,
          templateRevision: template?.revision ?? null,
          name,
          instructions,
          allowedTools,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertDefinition(definition);
        return definition;
      });

    const createTemplate: BotServiceShape["createTemplate"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Template ID", 128),
          catch: () => new BotValidationError("Invalid template ID"),
        });
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Template name", 200),
          catch: () => new BotValidationError("Invalid template name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Template instructions", 16_000),
          catch: () => new BotValidationError("Invalid template instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => {
            const tools = input.allowedTools ?? [];
            if (tools.length > 32) throw new BotValidationError("Too many tools");
            return [...new Set(tools.map((tool) => nonEmpty(tool, "Tool", 100)))];
          },
          catch: () => new BotValidationError("Invalid tool grants"),
        });
        if (input.projectId !== null && !(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new BotValidationError("Project does not exist"));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const template: BotTemplate = {
          ...input,
          id,
          name,
          instructions,
          allowedTools,
          autoCreateForFeature: input.autoCreateForFeature ?? false,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertTemplate(template);
        return template;
      });

    const updateTemplate: BotServiceShape["updateTemplate"] = (input) =>
      Effect.gen(function* () {
        const previous = yield* store.getTemplate(input.id);
        if (
          !previous ||
          previous.projectId !== input.projectId ||
          previous.revision !== input.expectedRevision ||
          !Number.isSafeInteger(input.expectedRevision)
        ) {
          return yield* Effect.fail(new BotValidationError("Template changed or is unavailable"));
        }
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Template name", 200),
          catch: () => new BotValidationError("Invalid template name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Template instructions", 16_000),
          catch: () => new BotValidationError("Invalid template instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => {
            if ((input.allowedTools?.length ?? 0) > 32) throw new Error("Too many tools");
            return [
              ...new Set((input.allowedTools ?? []).map((tool) => nonEmpty(tool, "Tool", 100))),
            ];
          },
          catch: () => new BotValidationError("Invalid tool grants"),
        });
        const updated: BotTemplate = {
          ...previous,
          name,
          instructions,
          allowedTools,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          enabled: input.enabled,
          autoCreateForFeature: input.autoCreateForFeature ?? false,
          revision: previous.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!(yield* store.updateTemplate(updated, previous.revision))) {
          return yield* Effect.fail(new BotValidationError("Template changed; reload and retry"));
        }
        return updated;
      });

    const createRun: BotServiceShape["createRun"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Run ID", 128),
          catch: () => new BotValidationError("Invalid run ID"),
        });
        const taskText = yield* Effect.try({
          try: () => nonEmpty(input.taskText, "Task", 16_000),
          catch: () => new BotValidationError("Invalid task"),
        });
        const request = { ...input, id, taskText };
        const existing = yield* store.getRun(id);
        if (existing !== null) {
          if (!sameRunRequest(existing, request)) {
            return yield* Effect.fail(new BotValidationError("Run ID belongs to another request"));
          }
          if (existing.dispatchState === BOT_DISPATCH_STATE.QUEUED) yield* dispatch(existing);
          return (yield* store.getRun(id))!;
        }
        const bot = yield* store.getDefinition(input.botId);
        if (bot === null || !bot.enabled) {
          return yield* Effect.fail(new BotValidationError("Bot is unavailable"));
        }
        if (bot.projectId !== null && bot.projectId !== input.projectId) {
          return yield* Effect.fail(new BotValidationError("Bot belongs to another project"));
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new BotValidationError("Project does not exist"));
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const run: BotRun = {
          id,
          botId: bot.id,
          projectId: input.projectId,
          threadId: ThreadId.make(`bot-run:${id}`),
          taskText,
          title: `${bot.name}: ${taskText.slice(0, 80)}`,
          instructions: bot.instructions,
          allowedTools: bot.allowedTools,
          botRevision: bot.revision,
          modelSelection: input.modelSelection ?? bot.modelSelection,
          runtimeMode: bot.runtimeMode,
          dispatchState: BOT_DISPATCH_STATE.QUEUED,
          recoveryAttempt: 0,
          lastError: null,
          createdAt,
          dispatchedAt: null,
        };
        yield* store.insertRun(run);
        const persisted = yield* store.getRun(id);
        if (persisted === null || !sameRunRequest(persisted, request)) {
          return yield* Effect.fail(new BotValidationError("Run ID belongs to another request"));
        }
        if (persisted.dispatchState === BOT_DISPATCH_STATE.QUEUED) yield* dispatch(persisted);
        return (yield* store.getRun(id))!;
      });

    return {
      ensureCrew: (projectId, modelSelection) =>
        Effect.gen(function* () {
          if (!(yield* runtime.projectExists(projectId))) {
            return yield* Effect.fail(new BotValidationError("Project does not exist"));
          }
          const managerId = `bot-manager:${projectId}`;
          const builderId = `bot-builder:${projectId}`;
          const templates = [
            {
              id: "template:captain",
              projectId: null,
              name: "Captain",
              autoCreateForFeature: false,
            },
            {
              id: `template:manager:${projectId}`,
              projectId,
              name: "Manager",
              autoCreateForFeature: false,
            },
            {
              id: `template:planner:${projectId}`,
              projectId,
              name: "Planner",
              autoCreateForFeature: true,
            },
            {
              id: `template:designer:${projectId}`,
              projectId,
              name: "Designer",
              autoCreateForFeature: true,
            },
            {
              id: `template:builder:${projectId}`,
              projectId,
              name: "Builder",
              autoCreateForFeature: true,
            },
            {
              id: `template:qa-tester:${projectId}`,
              projectId,
              name: "QA Tester",
              autoCreateForFeature: true,
            },
            {
              id: `template:reviewer:${projectId}`,
              projectId,
              name: "Reviewer",
              autoCreateForFeature: true,
            },
          ];
          for (const template of templates) {
            if (!(yield* store.getTemplate(template.id))) {
              yield* createTemplate({
                ...template,
                instructions: `You are the ${template.name} bot. Follow the assigned feature task and report a structured result.`,
                allowedTools: template.autoCreateForFeature
                  ? ["bots.respond", "bots.ask", "bots.status"]
                  : [],
                modelSelection,
                runtimeMode: "approval-required",
              }).pipe(
                Effect.catch((error) =>
                  store
                    .getTemplate(template.id)
                    .pipe(
                      Effect.flatMap((persisted) =>
                        persisted?.projectId === template.projectId
                          ? Effect.succeed(persisted)
                          : Effect.fail(error),
                      ),
                    ),
                ),
              );
            }
          }
          const defaults = [
            {
              id: "bot-captain",
              projectId: null,
              templateId: "template:captain",
              name: "Captain",
              instructions:
                "You are Captain. Coordinate the person's project request. Follow the task's coordination boundary: when a workflow runner owns scheduling, do not independently delegate its steps. Otherwise delegate to the named project Manager using bots_delegate with a stable request ID, then use bots_wait_handoff for a completed, failed, or needs-input outcome. Relay the outcome clearly to the person. Use bots_list_handoffs to recover state after a restart. Never claim work is done without a structured outcome.",
              allowedTools: ["bots.delegate", "bots.status", "features.status"],
            },
            {
              id: managerId,
              projectId,
              templateId: `template:manager:${projectId}`,
              name: "Manager",
              instructions: `You manage project ${projectId}. Follow the assigned coordination boundary. When a workflow runner schedules the task steps, supervise questions and decisions without independently dispatching implementation. For other implementation requests, delegate to bot ${builderId} using bots_delegate and a stable request ID, then use bots_wait_handoff for its structured outcome. Report requested outcomes through bots_respond. If a child needs a person's answer, use bots_ask and pass the answer to the child using bots_answer. Keep the task and context bounded.`,
              allowedTools: [
                "bots.delegate",
                "bots.respond",
                "bots.ask",
                "bots.status",
                "bots.answer",
                "features.status",
              ],
            },
            {
              id: builderId,
              projectId,
              templateId: `template:builder:${projectId}`,
              name: "Builder",
              instructions: `You build a bounded task for project ${projectId}. Work in the linked T3 thread. Call bots_respond with completed or failed and a concise summary when finished. If information is missing, call bots_ask with the exact question, then continue after an answer. Do not report completion solely in prose.`,
              allowedTools: ["bots.respond", "bots.ask"],
            },
          ];
          const definitions: Array<BotDefinition> = [];
          const created = new Set<string>();
          for (const definition of defaults) {
            const existing = yield* store.getDefinition(definition.id);
            if (existing) {
              if (existing.projectId !== definition.projectId) {
                return yield* Effect.fail(new BotValidationError("Default bot ID is in use"));
              }
              definitions.push(existing);
            } else {
              created.add(definition.id);
              definitions.push(
                yield* createDefinition({
                  ...definition,
                  modelSelection,
                  runtimeMode: "approval-required",
                }).pipe(
                  Effect.catch((error) =>
                    store
                      .getDefinition(definition.id)
                      .pipe(
                        Effect.flatMap((persisted) =>
                          persisted?.projectId === definition.projectId
                            ? Effect.succeed(persisted)
                            : Effect.fail(error),
                        ),
                      ),
                  ),
                ),
              );
            }
          }
          if (created.has("bot-captain") || created.has(managerId)) {
            yield* store.grantDelegation("bot-captain", managerId);
          }
          if (created.has(managerId) || created.has(builderId)) {
            yield* store.grantDelegation(managerId, builderId);
          }
          if (created.has(managerId)) yield* store.setParent(managerId, "bot-captain", 0);
          if (created.has(builderId)) yield* store.setParent(builderId, managerId, 0);
          return definitions;
        }),
      createDefinition,
      createTemplate,
      updateTemplate,
      getDefinition: store.getDefinition,
      getTemplate: store.getTemplate,
      listTemplatesForProject: store.listTemplatesForProject,
      instantiate: (id, projectId, templateId) =>
        Effect.gen(function* () {
          const template = yield* store.getTemplate(templateId);
          if (
            !template?.enabled ||
            (template.projectId !== null && template.projectId !== projectId)
          ) {
            return yield* Effect.fail(new BotValidationError("Source template is unavailable"));
          }
          return yield* createDefinition({
            id,
            projectId,
            templateId,
            name: template.name,
            instructions: template.instructions,
            allowedTools: template.allowedTools,
            modelSelection: template.modelSelection,
            runtimeMode: template.runtimeMode,
          });
        }),
      listDelegationGrantsForProject: store.listDelegationGrantsForProject,
      revokeDelegation: store.revokeDelegation,
      listHierarchyForProject: store.listHierarchyForProject,
      setHierarchyParent: (botId, parentBotId, position = 0) =>
        Effect.gen(function* () {
          const child = yield* store.getDefinition(botId);
          const parent = parentBotId === null ? null : yield* store.getDefinition(parentBotId);
          if (!child?.enabled || (parentBotId !== null && !parent?.enabled)) {
            return yield* Effect.fail(new BotValidationError("Bot is unavailable"));
          }
          if (
            !Number.isSafeInteger(position) ||
            position < 0 ||
            position > 10_000 ||
            (parent &&
              ((child.projectId === null && parent.projectId !== null) ||
                (parent.projectId !== null && parent.projectId !== child.projectId) ||
                (parent.featureId !== null && parent.featureId !== child.featureId)))
          ) {
            return yield* Effect.fail(new BotValidationError("Invalid hierarchy placement"));
          }
          if (!(yield* store.setParent(botId, parentBotId, position))) {
            return yield* Effect.fail(new BotValidationError("Hierarchy cycle rejected"));
          }
        }),
      allowDelegation: (sourceBotId, targetBotId) =>
        Effect.gen(function* () {
          const source = yield* store.getDefinition(sourceBotId);
          const target = yield* store.getDefinition(targetBotId);
          if (
            !source ||
            !target ||
            !source.enabled ||
            !target.enabled ||
            sourceBotId === targetBotId ||
            (source.projectId !== null && target.projectId !== source.projectId)
          ) {
            return yield* Effect.fail(new BotValidationError("Invalid delegation grant"));
          }
          yield* store.grantDelegation(sourceBotId, targetBotId);
        }),
      createRun,
      getRun: (id) =>
        store.getRun(id).pipe(
          Effect.flatMap((run) =>
            run === null
              ? Effect.succeed(null)
              : runtime.getTurnState(run.threadId).pipe(
                  Effect.map((turnState) => ({
                    run,
                    turnState,
                    status:
                      run.dispatchState === BOT_DISPATCH_STATE.QUEUED
                        ? ("queued" as const)
                        : turnState === BOT_TURN_STATE.COMPLETED
                          ? ("completed" as const)
                          : turnState === BOT_TURN_STATE.ERROR ||
                              turnState === BOT_TURN_STATE.MISSING
                            ? ("failed" as const)
                            : turnState === BOT_TURN_STATE.INTERRUPTED
                              ? ("interrupted" as const)
                              : ("running" as const),
                  })),
                ),
          ),
        ),
      listRunSummaries: (projectId, limit = 50) =>
        store.listRunSummaries(projectId, Math.max(1, Math.min(100, Math.floor(limit)))),
      reconcileRuns: () =>
        Effect.gen(function* () {
          // Recover accepted turns from a prior process before dispatching new queued runs.
          // Otherwise a newly dispatched turn could look stale before its reactor worker starts.
          let afterId = "";
          while (true) {
            const ids = yield* runtime.listPendingStartedRunIds(afterId, 100);
            if (ids.length === 0) break;
            yield* Effect.forEach(
              ids,
              (id) =>
                store
                  .getRun(id)
                  .pipe(Effect.flatMap((run) => (run === null ? Effect.void : replayPending(run)))),
              { concurrency: 1, discard: true },
            );
            afterId = ids[ids.length - 1]!;
          }
          const queued = yield* store.listQueuedRuns();
          yield* Effect.forEach(queued, (run) => dispatch(run).pipe(Effect.result), {
            concurrency: 1,
            discard: true,
          });
        }),
    } satisfies BotServiceShape;
  }),
);
