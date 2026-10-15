import * as NodeCrypto from "node:crypto";

import { type FeatureLaunchInput, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BotStore } from "../bots/BotStore.ts";
import { BotHandoffService, type BotHandoffError } from "../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../bots/BotHandoffStore.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import { WorkflowExecutionService } from "../workflows/WorkflowExecutionService.ts";
import { type WorkflowBindings } from "../workflows/WorkflowExecutionStore.ts";
import {
  FeatureService,
  FeatureValidationError,
  type FeatureServiceError,
} from "./FeatureService.ts";
import { FeatureLaunchStore, type FeatureLaunch } from "./FeatureLaunchStore.ts";

type LaunchInput = typeof FeatureLaunchInput.Type & { readonly actorId: string };
type LaunchError = FeatureServiceError | BotHandoffError;

export class FeatureLaunchService extends Context.Service<
  FeatureLaunchService,
  {
    readonly launch: (input: LaunchInput) => Effect.Effect<FeatureLaunch, LaunchError>;
    readonly get: (
      featureId: string,
      projectId: ProjectId,
    ) => Effect.Effect<FeatureLaunch | null, FeatureServiceError>;
    readonly reconcile: () => Effect.Effect<void, FeatureServiceError>;
    readonly start: () => Effect.Effect<void, FeatureServiceError, Scope.Scope>;
  }
>()("t3/features/FeatureLaunchService") {}

const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const coordinationRunId = (featureId: string, sourceRunId: string, botId: string) =>
  `feature-supervisor:${NodeCrypto.createHash("sha256")
    .update(encodeIdentity([featureId, sourceRunId, botId]))
    .digest("hex")}`;

export const FeatureLaunchServiceLive = Layer.effect(
  FeatureLaunchService,
  Effect.gen(function* () {
    const features = yield* FeatureService;
    const launches = yield* FeatureLaunchStore;
    const workflows = yield* WorkflowService;
    const workflowStore = yield* WorkflowStore;
    const runner = yield* WorkflowExecutionService;
    const delegation = yield* BotHandoffService;
    const handoffs = yield* BotHandoffStore;
    const botStore = yield* BotStore;
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);

    const cancelPrepared = Effect.fn("FeatureLaunchService.cancelPrepared")(function* (
      record: FeatureLaunch,
    ) {
      // Stop the workflow task before its supervisors. Never interrupt the caller's root run.
      yield* runner.reconcileFeature(record.featureId);
      const copy = yield* workflows.getFeatureCopy(record.featureId);
      for (const name of Object.keys(copy?.definition.bots ?? {})) {
        const handoff = yield* handoffs.get(
          coordinationRunId(record.featureId, record.sourceRunId, name),
        );
        if (handoff && handoff.status !== "cancelled" && handoff.status !== "completed")
          yield* delegation.cancel(handoff.id);
      }
      yield* launches.update(
        record.featureId,
        "cancelled",
        null,
        DateTime.formatIso(yield* DateTime.now),
      );
      return (yield* launches.get(record.featureId))!;
    });

    const launch = Effect.fn("FeatureLaunchService.launch")(function* (input: LaunchInput) {
      const feature = yield* features.get(input.featureId);
      if (!feature || feature.projectId !== input.projectId) {
        return yield* Effect.fail(
          new FeatureValidationError("Feature is closed or unavailable in this project"),
        );
      }
      const prior = yield* launches.get(feature.id);
      if (prior && prior.sourceRunId !== input.sourceRunId) {
        return yield* Effect.fail(
          new FeatureValidationError("Feature launch belongs to another source run"),
        );
      }
      const copy = yield* workflows.getFeatureCopy(feature.id);
      if (
        !copy ||
        copy.projectId !== feature.projectId ||
        copy.definition.id !== feature.workflowId
      ) {
        return yield* Effect.fail(
          new FeatureValidationError(
            "Select a workflow when creating the feature before launching it",
          ),
        );
      }
      const state = yield* workflows.getFeatureState(feature.id);
      if (state?.cancelled) {
        if (!prior)
          return yield* Effect.fail(
            new FeatureValidationError("The feature workflow is cancelled"),
          );
        return yield* cancelPrepared(prior);
      }
      if (feature.status !== "open")
        return yield* Effect.fail(new FeatureValidationError("Feature is closed"));
      if (prior?.phase === "attached") {
        yield* runner.reconcileFeature(feature.id);
        return prior;
      }

      const root = yield* botStore.getRun(input.sourceRunId);
      const rootBot = root ? yield* botStore.getDefinition(root.botId) : null;
      if (
        !root ||
        !rootBot?.enabled ||
        root.projectId !== feature.projectId ||
        root.dispatchState !== "started" ||
        !root.allowedTools.includes("bots.delegate") ||
        (rootBot.featureId !== null && rootBot.featureId !== feature.id)
      ) {
        return yield* Effect.fail(
          new FeatureValidationError("An authorized source run from this project is required"),
        );
      }
      // Validate every assignment before starting any provider work.
      const assigned = yield* Effect.forEach(
        Object.entries(copy.definition.bots),
        ([name, assignment]) =>
          Effect.gen(function* () {
            const botId = feature.botAssignments[name];
            const bot = botId ? yield* botStore.getDefinition(botId) : null;
            if (
              !bot?.enabled ||
              bot.projectId !== feature.projectId ||
              !bot.allowedTools.includes("bots.respond") ||
              (assignment.template.kind === "template"
                ? bot.featureId !== feature.id ||
                  bot.templateId !== assignment.template.id ||
                  bot.templateRevision !== assignment.template.revision
                : bot.id !== assignment.template.id || bot.featureId !== null)
            ) {
              return yield* Effect.fail(
                new FeatureValidationError(`Feature bot assignment is unavailable: ${name}`),
              );
            }
            return [name, bot] as const;
          }),
      );
      const assignedBots = new Map(assigned);
      for (const [name, assignment] of Object.entries(copy.definition.bots)) {
        const source =
          assignment.supervisor === null ? rootBot : assignedBots.get(assignment.supervisor);
        const target = assignedBots.get(name)!;
        if (
          !source?.enabled ||
          !source.allowedTools.includes("bots.delegate") ||
          !(yield* botStore.canDelegate(source.id, target.id))
        ) {
          return yield* Effect.fail(
            new FeatureValidationError(`Delegation is not authorized for workflow bot: ${name}`),
          );
        }
      }

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if ((yield* features.get(feature.id))?.status !== "open")
              return yield* Effect.fail(new FeatureValidationError("Feature is closed"));
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* launches.reserve({
              featureId: feature.id,
              projectId: feature.projectId,
              sourceRunId: root.id,
              actorId: input.actorId,
              phase: "pending",
              lastError: null,
              createdAt: now,
              updatedAt: now,
            });
            if ((yield* launches.get(feature.id))?.sourceRunId !== root.id)
              return yield* Effect.fail(
                new FeatureValidationError("Feature launch belongs to another source run"),
              );
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.fail(toPersistenceSqlError("FeatureLaunchService.reserve")(error)),
          ),
        );

      return yield* Effect.gen(function* () {
        const supervisors = new Map<string, string>();
        const prepareSupervisor: (name: string) => Effect.Effect<string, LaunchError> = Effect.fn(
          "FeatureLaunchService.prepareSupervisor",
        )(function* (name: string) {
          const existing = supervisors.get(name);
          if (existing) return existing;
          const assignment = copy.definition.bots[name]!;
          const bot = assignedBots.get(name)!;
          const sourceId =
            assignment.supervisor === null
              ? root.id
              : yield* prepareSupervisor(assignment.supervisor);
          const source = (yield* botStore.getRun(sourceId))!;
          const id = coordinationRunId(feature.id, root.id, name);
          yield* sql`INSERT OR IGNORE INTO feature_run_links (run_id, feature_id, kind)
            VALUES (${"bot-handoff:" + id}, ${feature.id}, 'coordination')`.pipe(
            Effect.mapError(toPersistenceSqlError("FeatureLaunchService.linkSupervisor")),
          );
          const priorHandoff = yield* handoffs.get(id);
          const handoff =
            priorHandoff?.status === "failed"
              ? yield* delegation.retry(id)
              : yield* delegation.delegate({
                  id,
                  sourceThreadId: source.threadId,
                  targetBotId: bot.id,
                  projectId: feature.projectId,
                  taskText: `Supervise feature ${feature.id}: ${feature.title}.\n${feature.brief.length > 6_000 ? "Brief excerpt:\n" : "Brief:\n"}${feature.brief.slice(0, 6_000)}\nThe workflow runner schedules the task steps. Handle questions and decisions when notified; do not independently dispatch those steps.`,
                });
          if (handoff.status === "failed" || handoff.status === "cancelled")
            return yield* Effect.fail(
              new FeatureValidationError("Supervisor preparation did not start"),
            );
          supervisors.set(name, handoff.targetRunId);
          return handoff.targetRunId;
        });
        for (const assignment of Object.values(copy.definition.bots)) {
          if (assignment.supervisor === null) continue;
          yield* prepareSupervisor(assignment.supervisor);
          if ((yield* workflows.getFeatureState(feature.id))?.cancelled)
            return yield* cancelPrepared((yield* launches.get(feature.id))!);
        }
        if ((yield* workflows.getFeatureState(feature.id))?.cancelled)
          return yield* cancelPrepared((yield* launches.get(feature.id))!);
        const bindings: WorkflowBindings = Object.fromEntries(
          Object.entries(copy.definition.bots).map(([name, assignment]) => [
            name,
            {
              botId: assignedBots.get(name)!.id,
              dispatchRunId:
                assignment.supervisor === null ? root.id : supervisors.get(assignment.supervisor)!,
            },
          ]),
        );
        const featureContext = `Feature ${feature.id}: ${feature.title}\n${feature.brief.length > 800 ? "Brief excerpt:\n" : "Brief:\n"}${feature.brief.slice(0, 800)}`;
        yield* runner.attach(feature.id, feature.projectId, bindings, featureContext);
        if ((yield* workflows.getFeatureState(feature.id))?.cancelled)
          return yield* cancelPrepared((yield* launches.get(feature.id))!);
        yield* launches.update(
          feature.id,
          "attached",
          null,
          DateTime.formatIso(yield* DateTime.now),
        );
        return (yield* launches.get(feature.id))!;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if ((yield* workflows.getFeatureState(feature.id))?.cancelled)
              return yield* cancelPrepared((yield* launches.get(feature.id))!);
            yield* launches.update(
              feature.id,
              "pending",
              String(error).slice(0, 2_000),
              DateTime.formatIso(yield* DateTime.now),
            );
            return yield* Effect.fail(error);
          }),
        ),
      );
    }, lock.withPermits(1));

    const reconcile = Effect.fn("FeatureLaunchService.reconcile")(function* (
      cancelledOnly = false,
    ) {
      let afterId = "";
      while (true) {
        const active = yield* launches.listActive(afterId);
        if (active.length === 0) return;
        for (const record of active) {
          const cancelled = (yield* workflows.getFeatureState(record.featureId))?.cancelled;
          if (!cancelled && (cancelledOnly || record.phase !== "pending")) continue;
          yield* launch(record).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Feature launch recovery failed", {
                featureId: record.featureId,
                error,
              }),
            ),
          );
        }
        afterId = active[active.length - 1]!.featureId;
      }
    });

    return FeatureLaunchService.of({
      launch,
      get: (id, projectId) =>
        launches
          .get(id)
          .pipe(Effect.map((record) => (record?.projectId === projectId ? record : null))),
      reconcile: () => reconcile(),
      start: Effect.fn("FeatureLaunchService.start")(function* () {
        const changes = yield* workflowStore.subscribeChanges;
        yield* changes.pipe(
          Stream.runForEach((id) =>
            Effect.gen(function* () {
              if (!(yield* workflows.getFeatureState(id))?.cancelled) return;
              const record = yield* launches.get(id);
              if (record && record.phase !== "cancelled") yield* launch(record);
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Feature launch cancellation failed", { featureId: id, error }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        // Apply persisted cancellation before bot replay can dispatch queued setup work.
        yield* reconcile(true);
      }),
    });
  }),
);
