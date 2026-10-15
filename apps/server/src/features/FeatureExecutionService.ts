import * as NodeCrypto from "node:crypto";
import {
  BotRunSummary,
  BotHandoff,
  FeatureArtifact,
  FeatureCheckout,
  type FeatureInspection,
  type FeaturePrepareCheckoutInput,
  type FeatureRecordArtifactInput,
  type ProjectId,
  CommandId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BotStore } from "../bots/BotStore.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorktreeBootstrapService } from "../project/WorktreeBootstrapService.ts";
import {
  FeatureService,
  FeatureValidationError,
  type FeatureServiceError,
} from "./FeatureService.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { featureWriter } from "./FeatureWriterLease.ts";

export class FeatureExecutionService extends Context.Service<
  FeatureExecutionService,
  {
    readonly inspect: (
      featureId: string,
      projectId: ProjectId,
    ) => Effect.Effect<FeatureInspection | null, FeatureServiceError>;
    readonly prepare: (
      input: typeof FeaturePrepareCheckoutInput.Type & { readonly actorId: string },
    ) => Effect.Effect<FeatureCheckout, FeatureServiceError>;
    readonly recordArtifact: (
      input: typeof FeatureRecordArtifactInput.Type & { readonly actorId: string },
    ) => Effect.Effect<FeatureArtifact, FeatureServiceError>;
  }
>()("t3/features/FeatureExecutionService") {}

const checkoutColumns = `feature_id AS featureId, project_id AS projectId, mode, phase, setup_thread_id AS setupThreadId, project_cwd AS projectCwd, path, branch, base_branch AS baseBranch, actor_id AS actorId, last_error AS lastError, updated_at AS updatedAt`;
const artifactColumns = `id, feature_id AS featureId, kind, title, url, status, detail, actor_id AS actorId, thread_id AS threadId, created_at AS createdAt`;
const decodeCheckout = Schema.decodeUnknownSync(FeatureCheckout);
const decodeArtifact = Schema.decodeUnknownSync(FeatureArtifact);
const decodeRun = Schema.decodeUnknownSync(BotRunSummary);
const decodeHandoff = Schema.decodeUnknownSync(BotHandoff);

export const FeatureExecutionServiceLive = Layer.effect(
  FeatureExecutionService,
  Effect.gen(function* () {
    const background = yield* ThreadBackgroundLivenessService;
    const sql = yield* SqlClient.SqlClient;
    const features = yield* FeatureService;
    const bots = yield* BotStore;
    const query = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitWorkflowService;
    const bootstrap = yield* WorktreeBootstrapService;
    const fs = yield* FileSystem.FileSystem;
    const locks = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>();
    const withFeatureLock = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      input: typeof FeaturePrepareCheckoutInput.Type,
    ) =>
      Effect.suspend(() => {
        const lock = locks.get(input.featureId) ?? Semaphore.makeUnsafe(1);
        locks.set(input.featureId, lock);
        return lock.withPermits(1)(effect);
      });
    const persistenceError = toPersistenceSqlError("FeatureExecutionService.query");
    const checkout = (id: string) =>
      sql`SELECT ${sql.unsafe(checkoutColumns)} FROM feature_checkouts WHERE feature_id = ${id}`.pipe(
        Effect.mapError(persistenceError),
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => (rows[0] ? decodeCheckout(rows[0]) : null),
            catch: persistenceError,
          }),
        ),
      );
    const requireFeature = Effect.fn("FeatureExecutionService.requireFeature")(function* (
      id: string,
      projectId: ProjectId,
    ) {
      const feature = yield* features.get(id);
      if (!feature || feature.projectId !== projectId)
        return yield* Effect.fail(new FeatureValidationError("Feature not found in this project"));
      return feature;
    });
    return FeatureExecutionService.of({
      prepare: Effect.fn("FeatureExecutionService.prepare")(function* (input) {
        if (
          input.baseBranch !== undefined &&
          (!input.baseBranch.trim() || input.baseBranch.length > 200)
        )
          return yield* Effect.fail(
            new FeatureValidationError("Use a non-empty base branch of at most 200 characters"),
          );
        const feature = yield* requireFeature(input.featureId, input.projectId);
        if (feature.status !== "open")
          return yield* Effect.fail(
            new FeatureValidationError("Reopen the feature before preparing its checkout"),
          );
        const prior = yield* checkout(feature.id);
        if (
          prior &&
          (prior.mode !== input.mode ||
            (input.baseBranch !== undefined && prior.baseBranch !== input.baseBranch))
        )
          return yield* Effect.fail(
            new FeatureValidationError("This feature already has a checkout configuration"),
          );
        if (prior?.phase === "ready") return prior;
        const project = yield* query.getProjectShellById(input.projectId);
        if (Option.isNone(project))
          return yield* Effect.fail(new FeatureValidationError("Project is unavailable"));
        const cwd = yield* fs
          .realPath(project.value.workspaceRoot)
          .pipe(Effect.mapError((error) => new FeatureValidationError(String(error))));
        const now = DateTime.formatIso(yield* DateTime.now);
        const branch =
          input.mode === "worktree"
            ? `bosun/feature-${NodeCrypto.createHash("sha256").update(feature.id).digest("hex").slice(0, 20)}`
            : null;
        const baseBranch = prior?.baseBranch ?? input.baseBranch ?? "HEAD";
        yield* sql`INSERT INTO feature_checkouts(feature_id, project_id, mode, phase, project_cwd, path, branch, base_branch, actor_id, updated_at)
        VALUES (${feature.id}, ${feature.projectId}, ${input.mode}, 'pending', ${cwd}, NULL, ${branch}, ${input.mode === "worktree" ? baseBranch : null}, ${input.actorId}, ${now})
        ON CONFLICT(feature_id) DO UPDATE SET phase = 'pending', last_error = NULL, updated_at = excluded.updated_at`.pipe(
          Effect.mapError(persistenceError),
        );
        return yield* Effect.gen(function* () {
          let path = cwd;
          if (input.mode === "worktree") {
            if (prior?.path) {
              // A failed setup may already own a checkout. Recover it in place; dirty files survive.
              const status = yield* git.localStatus({ cwd: prior.path });
              if (!status.isRepo || status.refName !== prior.branch)
                return yield* Effect.fail(
                  new FeatureValidationError(
                    "The recorded feature checkout changed; inspect it before retrying",
                  ),
                );
              path = prior.path;
            } else {
              const base = yield* bootstrap.resolveBase({ projectCwd: cwd, baseBranch });
              if (!base)
                return yield* Effect.fail(
                  new FeatureValidationError(
                    "A feature worktree needs a Git repository with a commit. Use the project workspace for non-coding work.",
                  ),
                );
              const tree = yield* bootstrap.create(
                { cwd, refName: base, newRefName: branch!, baseRefName: baseBranch, path: null },
                {
                  progress: {
                    onWorktreeClaimed: (path) =>
                      sql`UPDATE feature_checkouts SET path = ${normalizeProjectPathForComparison(path)} WHERE feature_id = ${feature.id}`.pipe(
                        Effect.asVoid,
                        Effect.orDie,
                      ),
                  },
                },
              );
              path = tree.worktree.path;
            }
          }
          if (input.mode === "worktree") {
            const definitions = yield* bots.listDefinitionsForProject(input.projectId);
            const modelSelection =
              project.value.defaultModelSelection ??
              definitions.find((bot) => bot.featureId === feature.id)?.modelSelection ??
              definitions.find((bot) => bot.enabled)?.modelSelection;
            if (!modelSelection)
              return yield* Effect.fail(
                new FeatureValidationError(
                  "Choose a project default agent or initialize Bots before setting up its worktree",
                ),
              );
            const setupThreadId = ThreadId.make(
              `feature-setup:${NodeCrypto.createHash("sha256").update(feature.id).digest("hex").slice(0, 24)}`,
            );
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`${setupThreadId}:create`),
              threadId: setupThreadId,
              projectId: input.projectId,
              title: `${feature.title} · checkout setup`,
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch,
              worktreePath: path,
              createdAt: now,
            });
            yield* sql`UPDATE feature_checkouts SET setup_thread_id = ${setupThreadId} WHERE feature_id = ${feature.id}`;
            const setup = yield* bootstrap.setup({
              threadId: setupThreadId,
              projectId: input.projectId,
              projectCwd: cwd,
              worktreePath: path,
              observeCompletion: {},
            });
            if (setup.status === "started" && setup.completion) {
              const completion = yield* setup.completion;
              if (completion.exitCode !== 0)
                return yield* Effect.fail(
                  new FeatureValidationError(
                    `Checkout setup did not finish successfully (exit ${completion.exitCode ?? "unknown"}). Open its setup thread, fix the problem, then retry.`,
                  ),
                );
            }
          }
          path = normalizeProjectPathForComparison(yield* fs.realPath(path));
          yield* sql`UPDATE feature_checkouts SET phase = 'ready', path = ${path}, last_error = NULL, updated_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE feature_id = ${feature.id}`;
          return (yield* checkout(feature.id))!;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* sql`UPDATE feature_checkouts SET phase = 'failed', last_error = ${String(error).slice(0, 2000)}, updated_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE feature_id = ${feature.id}`.pipe(
                Effect.mapError(persistenceError),
              );
              return yield* Effect.fail(new FeatureValidationError(String(error)));
            }),
          ),
        );
      }, withFeatureLock),
      recordArtifact: Effect.fn("FeatureExecutionService.recordArtifact")(
        function* (input) {
          yield* requireFeature(input.featureId, input.projectId);
          if (
            !input.id.trim() ||
            input.id.length > 128 ||
            !input.title.trim() ||
            input.title.length > 200 ||
            input.url.length > 2000 ||
            (input.detail?.length ?? 0) > 8000
          )
            return yield* Effect.fail(
              new FeatureValidationError("Artifact fields exceed their limits"),
            );
          let url: URL;
          try {
            url = new URL(input.url);
          } catch {
            return yield* Effect.fail(
              new FeatureValidationError("Use a complete HTTPS artifact link"),
            );
          }
          if (url.protocol !== "https:" || url.username || url.password)
            return yield* Effect.fail(
              new FeatureValidationError("Use a complete HTTPS artifact link without credentials"),
            );
          if (input.threadId) {
            const thread = yield* query.getThreadShellById(input.threadId);
            const linked =
              yield* sql`SELECT r.id FROM bot_runs r LEFT JOIN bots b ON b.id = r.bot_id
          LEFT JOIN feature_run_links l ON l.run_id = r.id WHERE r.thread_id = ${input.threadId} AND (b.feature_id = ${input.featureId} OR l.feature_id = ${input.featureId} OR r.id = (SELECT source_run_id FROM feature_launches WHERE feature_id = ${input.featureId}))`;
            if (
              Option.isNone(thread) ||
              thread.value.projectId !== input.projectId ||
              linked.length === 0
            )
              return yield* Effect.fail(
                new FeatureValidationError("Artifact thread is not linked to this feature"),
              );
          }
          const record: FeatureArtifact = {
            id: input.id,
            featureId: input.featureId,
            kind: input.kind,
            status: input.status,
            actorId: input.actorId,
            title: input.title.trim(),
            url: url.href,
            detail: input.detail ?? null,
            threadId: input.threadId ?? null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          // Records are attributable reports, not approval or execution of an external write.
          yield* sql`INSERT OR IGNORE INTO feature_artifacts (id, feature_id, kind, title, url, status, detail, actor_id, thread_id, created_at)
        VALUES (${record.id}, ${record.featureId}, ${record.kind}, ${record.title}, ${record.url}, ${record.status}, ${record.detail}, ${record.actorId}, ${record.threadId}, ${record.createdAt})`;
          const prior =
            yield* sql`SELECT ${sql.unsafe(artifactColumns)} FROM feature_artifacts WHERE id = ${input.id}`;
          const existing = decodeArtifact(prior[0]);
          if (
            Object.entries(record).some(
              ([key, value]) =>
                key !== "createdAt" && existing[key as keyof FeatureArtifact] !== value,
            )
          )
            return yield* Effect.fail(
              new FeatureValidationError("Artifact ID belongs to another record"),
            );
          return existing;
        },
        Effect.catchTag("SqlError", (error) => Effect.fail(persistenceError(error))),
      ),
      inspect: Effect.fn("FeatureExecutionService.inspect")(
        function* (id, projectId) {
          const feature = yield* features.get(id);
          if (!feature || feature.projectId !== projectId) return null;
          const selected = (yield* bots.listDefinitionsForProject(projectId)).filter(
            (bot) => bot.featureId === id || Object.values(feature.botAssignments).includes(bot.id),
          );
          const rows =
            yield* sql`SELECT r.id, r.bot_id AS botId, r.project_id AS projectId, r.thread_id AS threadId,
        r.dispatch_state AS dispatchState, r.last_error AS lastError, r.created_at AS createdAt,
        COALESCE((SELECT state FROM projection_turns t WHERE t.thread_id = r.thread_id ORDER BY t.row_id DESC LIMIT 1), 'missing') AS turnState
        FROM bot_runs r LEFT JOIN bots b ON b.id = r.bot_id LEFT JOIN feature_run_links l ON l.run_id = r.id
        WHERE r.project_id = ${projectId} AND (b.feature_id = ${id} OR l.feature_id = ${id} OR r.id = (SELECT source_run_id FROM feature_launches WHERE feature_id = ${id}))
        ORDER BY r.created_at DESC, r.id DESC LIMIT 100`;
          const runs = rows.map((row) => decodeRun(row));
          const requests =
            runs.length === 0
              ? []
              : (yield* sql`SELECT id, parent_id AS parentId, source_run_id AS sourceRunId, target_bot_id AS targetBotId, target_run_id AS targetRunId, project_id AS projectId, task_text AS taskText, context_text AS contextText, depth, status, response_text AS responseText, question_text AS questionText, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt FROM bot_handoffs WHERE target_run_id IN ${sql.in(runs.map((run) => run.id))} ORDER BY created_at DESC LIMIT 100`).map(
                  (row) => decodeHandoff(row),
                );
          const artifacts =
            (yield* sql`SELECT ${sql.unsafe(artifactColumns)} FROM feature_artifacts WHERE feature_id = ${id} ORDER BY created_at DESC, id DESC LIMIT 100`).map(
              (row) => decodeArtifact(row),
            );
          if (runs.length > 0) {
            const links = yield* sql<{
              threadId: string;
              url: string;
              repository: string;
              number: number;
              linkedAt: string;
              source: string;
            }>`SELECT thread_id AS threadId, url, repository, number, linked_at AS linkedAt, source FROM projection_thread_pull_requests WHERE thread_id IN ${sql.in(runs.map((run) => run.threadId))} ORDER BY linked_at DESC LIMIT 100`;
            for (const link of links) {
              const run = runs.find((run) => run.threadId === link.threadId)!;
              if (
                !artifacts.some(
                  (artifact) => artifact.url === link.url && artifact.threadId === run.threadId,
                )
              )
                artifacts.push({
                  id: `thread-pr:${run.id}:${link.number}`,
                  featureId: id,
                  kind: "pull-request",
                  title: `${link.repository} #${link.number}`,
                  url: link.url,
                  status: "linked",
                  detail: `Thread link (${link.source})`,
                  actorId: run.id,
                  threadId: run.threadId,
                  createdAt: link.linkedAt,
                });
            }
          }
          const tree = yield* checkout(id);
          return {
            feature,
            checkout: tree,
            writerThreadId:
              tree?.path && tree.mode === "worktree"
                ? yield* featureWriter(tree.path).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                    Effect.provideService(ThreadBackgroundLivenessService, background),
                  )
                : null,
            bots: selected,
            runs,
            handoffs: requests,
            artifacts,
          } satisfies FeatureInspection;
        },
        Effect.catchTag("SqlError", (error) => Effect.fail(persistenceError(error))),
      ),
    });
  }),
);
