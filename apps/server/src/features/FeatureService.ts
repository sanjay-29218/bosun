// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  workflowForwardOutcome,
  workflowForwardStages,
  type FeatureAttachThreadInput,
  type FeatureBoardCard,
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type FeatureThreadLink,
  PROJECT_MANAGER_ROLE_ID,
  type ProjectId,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { CrewHandoffStore } from "../crew/CrewHandoffStore.ts";
import * as BotStore from "../bots/BotStore.ts";
import { CrewService, type CrewServiceError } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { CrewThreadRuntime } from "../crew/CrewThreadRuntime.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkflowService, type WorkflowServiceError } from "../workflows/WorkflowService.ts";
import { projectWorkflowState } from "../workflows/WorkflowState.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import { featureBoardCard, featureBoardRunId } from "./featureBoard.ts";
import {
  decodeFeatureIssue,
  encodeFeatureIssue,
  featureTag,
  firstIssueUrl,
  issueNumberFromUrl,
} from "./featureIssue.ts";
import {
  WorkflowExecutionService,
  type WorkflowExecutionError,
} from "../workflows/WorkflowExecutionService.ts";
import {
  WorkflowExecutionStore,
  type WorkflowBindings,
} from "../workflows/WorkflowExecutionStore.ts";
import { featureCardState, stagePosition } from "../workflows/WorkflowState.ts";

class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export type FeatureRecord = typeof FeatureRecordSchema.Type;
export type CreateFeatureInput = typeof FeatureCreateInput.Type;

export type FeatureServiceError =
  | FeatureValidationError
  | CrewServiceError
  | PersistenceSqlError
  | WorkflowServiceError
  | WorkflowExecutionError;

export interface FeatureServiceShape {
  readonly create: (input: CreateFeatureInput) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly setStatus: (
    id: string,
    projectId: ProjectId,
    status: FeatureRecord["status"],
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  /**
   * Starts the feature's workflow. Each stage is sent from a lead run: its supervisor's, or the
   * owning bot's headquarters for stages without one. Those threads are where stage questions
   * and notices land.
   */
  readonly start: (
    id: string,
    projectId: ProjectId,
  ) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /** Opens a closed feature and resumes it: where it stopped, or at `stepId` after Done. */
  readonly reopen: (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly requestId: string;
    readonly actorId: string;
    readonly stepId?: string;
  }) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /**
   * Makes a person's existing thread the `stageId` stage of a new feature. The thread keeps
   * its ID, history, branch and worktree; earlier stages are skipped, and the stage completes
   * when the thread's turn finishes. A retry with the same feature ID returns the same feature.
   */
  readonly attachThread: (
    input: typeof FeatureAttachThreadInput.Type & { readonly actorId: string },
  ) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /**
   * Cancels the feature whose current stage this thread is, leaving the thread running as a
   * plain thread. Reopening the feature makes an attached thread its stage thread again.
   */
  readonly detachThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly actorId: string;
  }) => Effect.Effect<WorkflowFeatureSnapshot, FeatureServiceError>;
  /** The feature stage a thread drives, preferring one it is the current stage of. */
  readonly threadLink: (
    projectId: ProjectId,
    threadId: ThreadId,
  ) => Effect.Effect<FeatureThreadLink, FeatureServiceError>;
  /**
   * Links the issue at `url`, read through the project's source control, replacing any other;
   * null unlinks it. The feature's threads show it from their feature tag.
   */
  readonly setIssue: (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly url: string | null;
  }) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  /** `setIssue` for the feature a crew thread works on, from its feature tag. */
  readonly setIssueForThread: (
    threadId: ThreadId,
    url: string | null,
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly get: (id: string) => Effect.Effect<FeatureRecord | null, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureRecord>, PersistenceSqlError>;
  /** Board cards for the project's features that run a workflow, newest first. */
  readonly board: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureBoardCard>, PersistenceSqlError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()(
  "t3/features/FeatureService",
) {}

const validText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

const hashed = (prefix: string, featureId: string, id: string) =>
  `${prefix}:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([featureId, id]))
    .digest("hex")
    .slice(0, 32)}`;
/** The "feature-bot" prefix predates the Roles rename; existing member IDs keep it. */
const featureMemberId = (featureId: string, slot: string) => hashed("feature-bot", featureId, slot);

const featureLeadTask = (feature: FeatureRecord, definition: WorkflowDefinition) =>
  [
    `You lead feature "${feature.title}" (${feature.id}) on workflow ${definition.name}.`,
    "The workflow sends each stage to its crew member, so never delegate stage work yourself.",
    "Stage crew members ask you questions here. Answer with crew_answer when the brief or earlier results settle it; otherwise say exactly what the person must decide.",
    `Brief:\n${feature.brief.slice(0, 8_000)}`,
  ].join("\n\n");

const assignmentsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeAssignments = Schema.encodeSync(assignmentsJson);
const decodeAssignments = Schema.decodeSync(assignmentsJson);
interface FeatureRow extends Omit<FeatureRecord, "crewAssignments" | "issue"> {
  readonly crewAssignmentsJson: string;
  readonly issueJson: string | null;
}

/**
 * Re-tags the threads working on a feature from its stored title and issue. With `renamedFrom`,
 * threads still named after that earlier title take the new one.
 */
const syncFeatureThreads = (featureId: string, renamedFrom: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* OrchestratorV2;
    const [feature] = yield* sql<{
      readonly projectId: string;
      readonly title: string;
      readonly issueJson: string | null;
    }>`
      SELECT project_id AS projectId, title, issue_json AS issueJson FROM features
      WHERE id = ${featureId}
    `;
    if (!feature) return;
    const tag = featureTag({
      id: featureId,
      title: feature.title,
      issue: decodeFeatureIssue(feature.issueJson),
    });
    const threads = yield* sql<{ readonly threadId: ThreadId; readonly title: string }>`
      SELECT thread_id AS threadId, title FROM orchestration_v2_projection_threads
      WHERE project_id = ${feature.projectId} AND deleted_at IS NULL
        AND json_extract(payload_json, '$.feature.id') = ${featureId}
    `;
    yield* Effect.forEach(
      threads,
      (thread) =>
        engine.dispatch({
          type: "thread.crew-stage.set",
          commandId: CommandId.make(`feature-tag:${NodeCrypto.randomUUID()}`),
          threadId: thread.threadId,
          feature: tag,
          ...(renamedFrom !== null && thread.title === renamedFrom ? { title: feature.title } : {}),
        }),
      { discard: true },
    );
  });

/**
 * Replaces a feature's stand-in title, the start of its brief, with a short generated one,
 * as a new thread's first message gets. Threads already tagged with the feature follow, and
 * those still named after the stand-in take the new title.
 */
export const generateFeatureTitle = (feature: FeatureRecord) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const project = yield* projects.get(feature.projectId);
    if (Option.isNone(project)) return;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      feature.projectId,
    ).settings;
    const result = yield* textGeneration
      .generateThreadTitle({
        cwd: project.value.workspaceRoot,
        message: feature.brief,
        attachments: [],
        modelSelection: settings.textGenerationModelSelection,
      })
      .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }));
    const title = result.title.trim().slice(0, 200);
    if (!title || title === "New thread" || title === feature.title) return;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    // Only while the stand-in is still there.
    const renamed = yield* sql`
      UPDATE features SET title = ${title}, updated_at = ${updatedAt}
      WHERE id = ${feature.id} AND title = ${feature.title}
      RETURNING id
    `;
    if (renamed.length === 0) return;
    yield* syncFeatureThreads(feature.id, feature.title);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Feature title generation failed", {
            featureId: feature.id,
            cause,
          }),
    ),
  );

export const FeatureServiceLive = Layer.effect(
  FeatureService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crew = yield* CrewService;
    const crewStore = yield* CrewStore;
    const bots = yield* BotStore.BotStore;
    const runtime = yield* CrewThreadRuntime;
    const workflows = yield* WorkflowService;
    const workflowStore = yield* WorkflowStore;
    const executions = yield* WorkflowExecutionStore;
    const execution = yield* WorkflowExecutionService;
    const handoffStore = yield* CrewHandoffStore;
    const engine = yield* OrchestratorV2;
    const titleServices = yield* Effect.context<
      | ProjectStore.ProjectStoreV2
      | ServerSettings.ServerSettingsService
      | TextGeneration.TextGeneration
    >();
    const scope = yield* Effect.scope;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const queryError = toPersistenceSqlError("FeatureService.query");
    const decodeRow = (row: FeatureRow) =>
      Effect.try({
        try: () => {
          const { crewAssignmentsJson, issueJson, ...feature } = row;
          return {
            ...feature,
            crewAssignments: decodeAssignments(crewAssignmentsJson),
            issue: decodeFeatureIssue(issueJson),
          };
        },
        catch: toPersistenceSqlError("FeatureService.decode"),
      });

    const get: FeatureServiceShape["get"] = (id) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, w.workflow_id AS workflowId,
          w.workflow_revision AS workflowRevision,
          f.crew_assignments_json AS crewAssignmentsJson, f.issue_json AS issueJson
        FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
        WHERE f.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => (rows[0] ? decodeRow(rows[0]) : Effect.succeed(null))),
      );

    const requireFeature = (id: string, projectId: ProjectId) =>
      get(id).pipe(
        Effect.flatMap((feature) =>
          feature && feature.projectId === projectId
            ? Effect.succeed(feature)
            : Effect.fail(new FeatureValidationError("Feature not found in project")),
        ),
      );

    /** The bot that owns the project, once it can run: the crew is set up and it has a model. */
    const readyOwner = (projectId: ProjectId, action: string) =>
      Effect.gen(function* () {
        const ownerId = yield* bots.projectOwner(projectId);
        const owner = ownerId === null ? null : yield* bots.get(ownerId);
        if (!owner?.modelSelection) {
          return yield* Effect.fail(new FeatureValidationError(`Set up the crew before ${action}`));
        }
        return owner;
      });

    /**
     * The lead runs stages are sent from. Stages without a supervisor are led by the bot that
     * owns the project, from its headquarters, which every feature shares. Supervised stages are
     * led from one run per feature, tagged with the feature.
     */
    const leadBindings = (feature: FeatureRecord, definition: WorkflowDefinition) =>
      Effect.gen(function* () {
        const bindings: Record<string, WorkflowBindings[string]> = {};
        for (const [name, assignment] of Object.entries(definition.roles)) {
          const memberId = feature.crewAssignments[name];
          const owner =
            assignment.supervisor === null
              ? yield* readyOwner(feature.projectId, "starting a feature")
              : null;
          const leadMemberId = owner?.id ?? feature.crewAssignments[assignment.supervisor ?? ""];
          const lead = owner ? null : yield* crew.getMember(leadMemberId ?? "");
          if (!memberId || !leadMemberId || (!owner && !lead)) {
            return yield* Effect.fail(
              new FeatureValidationError(`Workflow role ${name} has no crew member`),
            );
          }
          if (owner) {
            const run = yield* crew.ensureHeadquarters(owner.id, feature.projectId);
            bindings[name] = { memberId, dispatchRunId: run.id };
            continue;
          }
          const run = yield* crew.createRun({
            id: hashed("feature-lead", feature.id, leadMemberId),
            memberId: leadMemberId,
            projectId: feature.projectId,
            taskText: featureLeadTask(feature, definition),
            ...(lead ? { title: lead.name } : {}),
          });
          // A fixed command ID tags the thread once.
          yield* engine
            .dispatch({
              type: "thread.crew-stage.set",
              commandId: CommandId.make(`feature-lead:${run.id}:feature`),
              threadId: run.threadId,
              feature: featureTag(feature),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Lead thread tag failed", { runId: run.id, error }),
              ),
            );
          bindings[name] = { memberId, dispatchRunId: run.id };
        }
        return bindings;
      });

    const create: FeatureServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        if (
          !validText(input.id, 128) ||
          !validText(input.title, 200) ||
          !validText(input.brief, 16_000)
        ) {
          return yield* Effect.fail(new FeatureValidationError("Invalid feature fields"));
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new FeatureValidationError("Project does not exist"));
        }
        const { feature, created } = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const existing = yield* get(input.id);
              if (existing) {
                if (
                  existing.projectId !== input.projectId ||
                  // A generated title has replaced the stand-in a retry sends again.
                  (!input.autoTitle && existing.title !== input.title) ||
                  existing.brief !== input.brief ||
                  existing.workflowId !== (input.workflowId ?? null)
                ) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Feature ID belongs to another request"),
                  );
                }
                return { feature: existing, created: false };
              }

              if (input.workflowId === undefined && (yield* workflows.getFeatureCopy(input.id))) {
                return yield* Effect.fail(
                  new FeatureValidationError("Feature ID is already attached to a workflow"),
                );
              }

              const copy =
                input.workflowId === undefined
                  ? null
                  : yield* workflows.copyForFeature(input.id, input.projectId, input.workflowId);
              // A member per role for this feature. The project manager role is the exception:
              // every feature shares the project's manager.
              const roles =
                copy === null
                  ? (yield* crewStore.listRoles())
                      .filter((role) => role.enabled && role.autoCreateForFeature)
                      .map((role) => ({ name: role.id, role }))
                  : yield* Effect.forEach(
                      Object.entries(copy.definition.roles).filter(
                        ([, slot]) => slot.roleId !== PROJECT_MANAGER_ROLE_ID,
                      ),
                      ([name, slot]) =>
                        Effect.gen(function* () {
                          const role = yield* crewStore.getRole(slot.roleId);
                          if (
                            !role?.enabled ||
                            !role.autoCreateForFeature ||
                            role.revision !== slot.roleRevision
                          ) {
                            return yield* Effect.fail(
                              new FeatureValidationError(
                                "Workflow role changed; revise the workflow",
                              ),
                            );
                          }
                          return { name, role };
                        }),
                    );
              const managerSlots =
                copy === null
                  ? []
                  : Object.entries(copy.definition.roles).filter(
                      ([, slot]) => slot.roleId === PROJECT_MANAGER_ROLE_ID,
                    );
              // A feature without a workflow reports to the manager when the crew has one.
              const manager =
                copy === null
                  ? yield* crew
                      .ensureProjectManager(input.projectId)
                      .pipe(Effect.catchTags({ CrewValidationError: () => Effect.succeed(null) }))
                  : managerSlots.length > 0
                    ? yield* crew.ensureProjectManager(input.projectId)
                    : null;
              const bindings = new Map<string, string>();
              for (const [name] of managerSlots) {
                if (!manager?.enabled) {
                  return yield* Effect.fail(
                    new FeatureValidationError("The project manager is unavailable"),
                  );
                }
                bindings.set(name, manager.id);
              }
              for (const { name, role } of roles) {
                const id = featureMemberId(input.id, name);
                if (yield* crewStore.getMember(id)) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Feature crew member ID is already in use"),
                  );
                }
                yield* crew.createMember({
                  id,
                  projectId: input.projectId,
                  featureId: input.id,
                  roleId: role.id,
                  name: role.name,
                  instructions: role.instructions,
                  allowedTools: role.allowedTools,
                  modelSelection: role.modelSelection,
                  runtimeMode: role.runtimeMode,
                });
                bindings.set(name, id);
              }
              for (const [position, { name }] of roles.entries()) {
                const id = bindings.get(name)!;
                const supervisor = copy?.definition.roles[name]?.supervisor;
                const parentId = copy
                  ? supervisor
                    ? bindings.get(supervisor)
                    : null
                  : manager?.enabled
                    ? manager.id
                    : null;
                if (parentId) {
                  yield* crew.setHierarchyParent(id, parentId, position);
                  yield* crew.allowDelegation(parentId, id);
                }
              }
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              const crewAssignments = Object.fromEntries(bindings);
              yield* sql`
              INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, crew_assignments_json)
              VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt}, ${createdAt}, 'open', ${encodeAssignments(crewAssignments)})
            `;
              const { autoTitle: _autoTitle, ...fields } = input;
              const feature: FeatureRecord = {
                ...fields,
                workflowId: input.workflowId ?? null,
                workflowRevision: copy?.definition.revision ?? null,
                crewAssignments,
                issue: null,
                createdAt,
                updatedAt: createdAt,
                status: "open",
              };
              return { feature, created: true };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
        // An issue linked in the brief comes first, so a generated title can read it.
        const issueUrl = created ? firstIssueUrl(feature.brief) : null;
        if (issueUrl !== null || (input.autoTitle && created)) {
          yield* Effect.gen(function* () {
            if (issueUrl !== null) {
              yield* setIssue({ id: feature.id, projectId: feature.projectId, url: issueUrl }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Linking the brief's issue failed", {
                    featureId: feature.id,
                    error,
                  }),
                ),
              );
            }
            if (input.autoTitle) {
              yield* generateFeatureTitle(feature).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.provideService(OrchestratorV2, engine),
                Effect.provideContext(titleServices),
              );
            }
          }).pipe(Effect.forkIn(scope));
        }
        return feature;
      });

    const setIssue: FeatureServiceShape["setIssue"] = (input) =>
      Effect.gen(function* () {
        const feature = yield* requireFeature(input.id, input.projectId);
        let issue: FeatureRecord["issue"] = null;
        if (input.url !== null) {
          const candidate = input.url.trim();
          const url = URL.canParse(candidate) ? new URL(candidate) : null;
          const number = url ? issueNumberFromUrl(url) : null;
          if (!url || number === null) {
            return yield* Effect.fail(new FeatureValidationError("Paste a link to an issue"));
          }
          url.hash = "";
          url.search = "";
          const project = yield* projects
            .get(feature.projectId)
            .pipe(Effect.mapError(toPersistenceSqlError("FeatureService.setIssue")));
          const lookup = Option.isSome(project)
            ? sourceControl.resolveLink({ cwd: project.value.workspaceRoot, url })
            : undefined;
          if (!lookup) {
            return yield* Effect.fail(
              new FeatureValidationError("Issues from this host can't be linked"),
            );
          }
          const subject = yield* lookup.pipe(
            Effect.mapError(
              () => new FeatureValidationError("The issue could not be read. Check the link"),
            ),
          );
          issue = {
            url: url.href,
            number,
            title: subject.title.slice(0, 300),
            state: subject.state ?? "open",
            milestone: subject.milestone ?? null,
            subIssues: subject.subIssues ?? null,
          };
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE features SET issue_json = ${issue ? encodeFeatureIssue(issue) : null},
            updated_at = ${updatedAt}
          WHERE id = ${feature.id}
        `.pipe(Effect.mapError(queryError));
        yield* syncFeatureThreads(feature.id, null).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(OrchestratorV2, engine),
          Effect.catch((error) =>
            Effect.logWarning("Feature issue tag failed", { featureId: feature.id, error }),
          ),
        );
        return { ...feature, issue, updatedAt };
      });

    const start: FeatureServiceShape["start"] = (id, projectId) =>
      Effect.gen(function* () {
        const feature = yield* requireFeature(id, projectId);
        if (feature.status !== "open") {
          return yield* Effect.fail(
            new FeatureValidationError("Reopen the feature before starting it"),
          );
        }
        const copy = yield* workflows.getFeatureCopy(id);
        if (!copy) {
          return yield* Effect.fail(new FeatureValidationError("This feature has no workflow"));
        }
        // Starting twice is a no-op: the execution already exists.
        if (!(yield* executions.get(id))) {
          yield* execution.attach(id, projectId, yield* leadBindings(feature, copy.definition));
        }
        return (yield* workflows.getFeatureSnapshot(id, projectId))!;
      });

    /** The stage `threadId` drives in one feature, from the workflow fold alone. */
    const stageInFeature = (
      featureId: string,
      projectId: ProjectId,
      threadId: ThreadId,
      runId: string | null,
    ) =>
      Effect.gen(function* () {
        const copy = yield* workflows.getFeatureCopy(featureId);
        const state =
          copy?.projectId === projectId ? yield* workflows.getFeatureState(featureId) : null;
        if (!copy || !state) return null;
        const step = [...state.steps.values()].find((candidate) =>
          runId === null ? candidate.threadId === threadId : candidate.runId === runId,
        );
        const position = step ? stagePosition(copy.definition, step.id) : null;
        if (!step || !position) return null;
        const queued = ((yield* executions.get(featureId))?.queuedAt ?? null) !== null;
        return {
          featureId,
          ...position,
          state: featureCardState(state, queued),
          current: state.activeStepId === step.id && !state.cancelled && !state.completed,
        };
      });

    const threadLink: FeatureServiceShape["threadLink"] = (projectId, threadId) =>
      Effect.gen(function* () {
        const runId = yield* handoffStore.getRunByThread(threadId);
        if (runId) {
          const handoff = yield* handoffStore.getForTargetRun(runId);
          const featureId = handoff ? yield* executions.findFeatureForHandoff(handoff.id) : null;
          const stage = featureId
            ? yield* stageInFeature(featureId, projectId, threadId, runId)
            : null;
          return { stage, attachable: false };
        }
        const stages = yield* Effect.forEach(
          yield* executions.findFeaturesForThread(threadId),
          (featureId) => stageInFeature(featureId, projectId, threadId, null),
        );
        const found = stages.filter((stage) => stage !== null);
        return {
          stage: found.find((stage) => stage.current) ?? found[0] ?? null,
          attachable: true,
        };
      });

    // Attach, detach and reopen check who owns a thread, then change it; one at a time.
    const ownership = yield* Semaphore.make(1);

    const readThread = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(() => new FeatureValidationError("Thread is unavailable")));

    const listByProject: FeatureServiceShape["listByProject"] = (projectId) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, w.workflow_id AS workflowId,
        w.workflow_revision AS workflowRevision,
          f.crew_assignments_json AS crewAssignmentsJson, f.issue_json AS issueJson
        FROM features f LEFT JOIN feature_workflows w ON w.feature_id = f.id
        WHERE f.project_id = ${projectId}
        ORDER BY f.created_at DESC, f.id DESC
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    return FeatureService.of({
      start,
      setIssue,
      setIssueForThread: (threadId, url) =>
        Effect.gen(function* () {
          const [thread] = yield* sql<{
            readonly projectId: ProjectId;
            readonly featureId: string | null;
          }>`
            SELECT project_id AS projectId, json_extract(payload_json, '$.feature.id') AS featureId
            FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
          `.pipe(Effect.mapError(queryError));
          if (!thread?.featureId) {
            return yield* Effect.fail(
              new FeatureValidationError("This thread doesn't work on a feature"),
            );
          }
          return yield* setIssue({ id: thread.featureId, projectId: thread.projectId, url });
        }),
      threadLink,
      attachThread: (input) =>
        Effect.gen(function* () {
          const shell = yield* readThread(engine.getThreadShell(input.threadId));
          if (!shell || shell.projectId !== input.projectId || shell.deletedAt !== null) {
            return yield* Effect.fail(new FeatureValidationError("Thread not found in project"));
          }
          if (shell.archivedAt !== null) {
            return yield* Effect.fail(
              new FeatureValidationError("Unarchive the thread before making it a feature"),
            );
          }
          if (yield* handoffStore.getRunByThread(input.threadId)) {
            return yield* Effect.fail(
              new FeatureValidationError("A crew thread can't become a feature"),
            );
          }
          const attachId = hashed("attach", input.featureId, input.threadId);
          const prior = yield* workflows.findRecordedEvent(input.featureId, attachId);
          if (prior) {
            const existing = yield* get(input.featureId);
            if (
              prior.stepId !== input.stageId ||
              existing?.workflowId !== input.workflowId ||
              existing.title !== input.title
            ) {
              return yield* Effect.fail(
                new FeatureValidationError("Feature ID belongs to another request"),
              );
            }
            return yield* start(input.featureId, input.projectId);
          }
          if ((yield* threadLink(input.projectId, input.threadId)).stage?.current) {
            return yield* Effect.fail(
              new FeatureValidationError("This thread is already a feature's current stage"),
            );
          }
          // Check the crew first, so a feature is never left made but unstarted.
          yield* readyOwner(input.projectId, "making a feature");
          const { messages } = yield* readThread(
            engine.getThreadRecords(input.threadId, ["messages"], { messageRoles: ["user"] }),
          );
          const brief =
            messages
              .find((message) => message.text.trim())
              ?.text.trim()
              .slice(0, 16_000) || input.title;
          const occurredAt = DateTime.formatIso(yield* DateTime.now);
          const event = {
            runId: null,
            outcome: null,
            sourceKind: null,
            sourceId: null,
            actorId: input.actorId,
            detail: null,
            occurredAt,
          } as const;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* create({
                  id: input.featureId,
                  projectId: input.projectId,
                  title: input.title,
                  brief,
                  workflowId: input.workflowId,
                });
                const copy = (yield* workflows.getFeatureCopy(input.featureId))!;
                const stages = workflowForwardStages(copy.definition);
                const index = stages.indexOf(input.stageId);
                if (index < 0) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Choose a stage on the workflow's path"),
                  );
                }
                for (const stepId of stages.slice(0, index)) {
                  yield* workflows.recordTrustedEvent(input.featureId, {
                    ...event,
                    id: hashed("attach-skip", input.featureId, stepId),
                    stepId,
                    executionId: null,
                    kind: "skipped",
                    outcome: workflowForwardOutcome(copy.definition, stepId),
                  });
                }
                yield* workflows.recordTrustedEvent(input.featureId, {
                  ...event,
                  id: attachId,
                  stepId: input.stageId,
                  executionId: hashed("execution", input.featureId, input.stageId),
                  kind: "attached",
                  threadId: input.threadId,
                });
              }),
            )
            .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
          return yield* start(input.featureId, input.projectId);
        }).pipe(ownership.withPermits(1)),
      detachThread: ({ projectId, threadId, requestId, actorId }) =>
        Effect.gen(function* () {
          const detach = (featureId: string) =>
            execution.control({
              featureId,
              projectId,
              requestId,
              actorId,
              kind: "cancelled",
              text: "Detached from the workflow",
            });
          // A retry finishes on the feature it first detached, whatever the thread is now.
          for (const featureId of yield* executions.findFeaturesForThread(threadId)) {
            if (yield* workflows.findRecordedEvent(featureId, requestId))
              return yield* detach(featureId);
          }
          const { stage, attachable } = yield* threadLink(projectId, threadId);
          // Cancelling a crew stage stops its run, so the thread could not carry on.
          if (!attachable) {
            return yield* Effect.fail(
              new FeatureValidationError(
                "A crew stage thread can't be detached; cancel the feature",
              ),
            );
          }
          if (!stage?.current) {
            return yield* Effect.fail(
              new FeatureValidationError("This thread is not a feature's current stage"),
            );
          }
          return yield* detach(stage.featureId);
        }).pipe(ownership.withPermits(1)),
      reopen: ({ id, projectId, requestId, actorId, stepId }) =>
        Effect.gen(function* () {
          const feature = yield* requireFeature(id, projectId);
          // Reopening reattaches a detached thread, unless it has since joined another feature.
          const state = yield* workflows.getFeatureState(id);
          const stopped = state?.stoppedStepId ? state.steps.get(state.stoppedStepId) : undefined;
          if (state?.cancelled && stopped?.threadId) {
            const { stage } = yield* threadLink(projectId, stopped.threadId);
            if (stage?.current && stage.featureId !== id) {
              return yield* Effect.fail(
                new FeatureValidationError("This feature's thread is now another feature's stage"),
              );
            }
          }
          if (feature.status === "closed") {
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            yield* sql`UPDATE features SET status = 'open', updated_at = ${updatedAt}
              WHERE id = ${id} AND project_id = ${projectId}`.pipe(Effect.mapError(queryError));
          }
          return yield* execution.control({
            featureId: id,
            projectId,
            requestId,
            actorId,
            kind: "reopened",
            ...(stepId === undefined ? {} : { stepId }),
          });
        }).pipe(ownership.withPermits(1)),
      get,
      setStatus: (id, projectId, status) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const feature = yield* get(id);
              if (!feature || feature.projectId !== projectId) {
                return yield* Effect.fail(
                  new FeatureValidationError("Feature not found in project"),
                );
              }
              if (status !== "open" && status !== "closed") {
                return yield* Effect.fail(new FeatureValidationError("Invalid feature status"));
              }
              if (feature.status === status) return feature;
              if (status === "closed") {
                const workflow = yield* workflows.getFeatureState(id);
                if (
                  workflow &&
                  ((yield* executions.get(id)) !== null || workflow.executionCount > 0) &&
                  !workflow.completed &&
                  !workflow.cancelled
                ) {
                  return yield* Effect.fail(
                    new FeatureValidationError(
                      "Finish or cancel the workflow before closing the feature",
                    ),
                  );
                }
              }
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`UPDATE features SET status = ${status}, updated_at = ${updatedAt}
            WHERE id = ${id} AND project_id = ${projectId}`;
              return { ...feature, status, updatedAt };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) })),
      listByProject,
      board: (projectId) =>
        Effect.gen(function* () {
          const records = yield* listByProject(projectId);
          const latest = new Map(
            (yield* workflowStore.listLatestDefinitions()).map((definition) => [
              definition.id,
              definition.revision,
            ]),
          );
          const cards = yield* Effect.forEach(
            records,
            (feature) =>
              Effect.gen(function* () {
                const copy = yield* workflowStore.getFeatureCopy(feature.id);
                if (!copy) return null;
                const events = yield* workflowStore.listEvents(feature.id);
                // One unreadable history must not hide the rest of the board.
                const state = yield* Effect.try(() =>
                  projectWorkflowState(copy.definition, events),
                ).pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning("Skipping feature with an unreadable workflow", {
                      featureId: feature.id,
                      error: String(error),
                    }),
                  ),
                  Effect.option,
                );
                if (state._tag === "None") return null;
                const runId = featureBoardRunId(
                  state.value,
                  events,
                  state.value.activeStepId ?? state.value.stoppedStepId,
                );
                const run = runId ? yield* crewStore.getRun(runId) : null;
                return featureBoardCard({
                  feature,
                  copy,
                  state: state.value,
                  events,
                  execution: yield* workflowStore.getExecutionStatus(feature.id),
                  latestRevision: latest.get(copy.definition.id) ?? null,
                  threadId: run?.threadId ?? null,
                });
              }),
            { concurrency: 8 },
          );
          return cards.filter((card) => card !== null);
        }),
      create,
    });
  }),
);
