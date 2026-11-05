// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  FEATURE_DELIVERY_WORKFLOW_ID,
  CommandId,
  MessageId,
  idleCompactionOf,
  type FeatureBoardCard,
  type FeatureIssue,
  type OrchestrationV2DomainEvent,
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type FeatureWorkspace,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as BotStore from "../bots/BotStore.ts";
import { FeatureWorkspaces } from "./FeatureWorkspaces.ts";
import { crewChangeNotifier } from "../crew/CrewChanges.ts";
import { CrewService, type CrewServiceError } from "../crew/CrewService.ts";
import { CrewStore, type Workflow } from "../crew/CrewStore.ts";
import {
  CrewThreadRuntime,
  decodeOpeningMessage,
  encodeOpeningMessage,
  type OpeningMessage,
} from "../crew/CrewThreadRuntime.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { featureLeadTask } from "../crew/crewPrompts.ts";
import {
  decodeFeatureIssue,
  encodeFeatureIssue,
  featureTag,
  firstIssueRef,
  issueNumberFromUrl,
  repositoryIssueNumber,
  trackerIssue,
} from "./featureIssue.ts";
import { readTicketByNumber, ticketNumberFromRef } from "../tickets/ticketRows.ts";
class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export type FeatureRecord = typeof FeatureRecordSchema.Type;
export type CreateFeatureInput = typeof FeatureCreateInput.Type & {
  /** The feature whose lead starts this one; leads start children, not clients. */
  readonly parentFeatureId?: string | undefined;
};

export type FeatureServiceError =
  | FeatureValidationError
  | AttachmentClaims.AttachmentClaimError
  | CrewServiceError
  | PersistenceSqlError;

export interface FeatureStartResult {
  readonly feature: FeatureRecord;
  readonly leadThreadId: ThreadId;
  /** The branch its worktree checks out; null when it works in the project's checkout. */
  readonly branch: string | null;
}

/** What a delegated crew thread runs as. */
export interface FeatureCrewMember {
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface FeatureServiceShape {
  readonly create: (input: CreateFeatureInput) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  readonly setStatus: (
    id: string,
    projectId: ProjectId,
    status: FeatureRecord["status"],
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  /**
   * Starts the feature: its worktree, and its lead's thread with the brief as the first message.
   * The lead runs the crew from there. Starting again returns the same lead.
   */
  readonly start: (
    id: string,
    projectId: ProjectId,
  ) => Effect.Effect<FeatureStartResult, FeatureServiceError>;
  /**
   * Creates a feature and starts it. A retry with the same `featureId` returns the same one.
   * `baseBranch`, which must exist, stacks it on another feature's branch.
   * `requesterThreadId`, for a feature that isn't a child, hears from the lead whenever it stops with its crew idle.
   */
  readonly launch: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly brief: string;
    readonly featureId?: string | undefined;
    readonly workspace?: FeatureWorkspace | undefined;
    readonly workflowId?: string | undefined;
    readonly baseBranch?: string | undefined;
    readonly parentFeatureId?: string | undefined;
    readonly requesterThreadId?: ThreadId | undefined;
  }) => Effect.Effect<FeatureStartResult, FeatureServiceError>;
  /** The bot that owns `projectId`, or null. */
  readonly projectBot: (projectId: ProjectId) => Effect.Effect<string | null, PersistenceSqlError>;
  /** The thread that started the feature and hears from its lead, or null. */
  readonly requesterThreadId: (
    featureId: string,
  ) => Effect.Effect<ThreadId | null, PersistenceSqlError>;
  /** The lead threads of open features that a thread started, which report to that thread. */
  readonly reportingLeads: Effect.Effect<ReadonlyArray<ThreadId>, PersistenceSqlError>;
  /**
   * The lead in `threadId` reports its feature done: its parent's lead gets `summary` with the
   * feature's branch and pull request. Closing a child that hasn't reported does the same.
   */
  readonly finishForThread: (
    threadId: ThreadId,
    summary: string,
  ) => Effect.Effect<FeatureRecord, FeatureServiceError>;
  /**
   * Once a child feature goes quiet (no thread of it running or waiting on the person) and its
   * lead didn't report during its last turn, tells the parent's lead, once per turn. A lead
   * forgetting `t3_feature_finish`, or a turn cut short, never leaves the parent waiting.
   */
  readonly reportIfQuiet: (threadId: ThreadId) => Effect.Effect<void, FeatureServiceError>;
  /**
   * A message sent to a lead at `sentAt`, after it reported its feature finished, means more
   * work even within the same run (steering), so the report no longer stands.
   */
  readonly withdrawFinished: (threadId: ThreadId, sentAt: string) => Effect.Effect<void>;
  /** Checks every open child feature once, for ones that went quiet while nobody watched. */
  readonly reconcileChildren: () => Effect.Effect<void, FeatureServiceError>;
  /**
   * Runs `reportIfQuiet` whenever a turn ends, a question resolves, or a crew result lands, and
   * clears a finished report when its lead gets another message.
   */
  readonly watchChildren: () => Effect.Effect<void, never, Scope.Scope>;
  /** The feature's crew member called `name`, which its lead delegates to; null when none is. */
  readonly crewMember: (
    featureId: string,
    name: string,
  ) => Effect.Effect<FeatureCrewMember | null, FeatureServiceError>;
  /** The names of the feature's crew members, as its lead addresses them. */
  readonly crewMemberNames: (
    featureId: string,
  ) => Effect.Effect<ReadonlyArray<string>, FeatureServiceError>;
  /**
   * Links the issue at `url`, read through the project's source control, or the project's
   * ticket when `url` is `T-<number>`, replacing any other; null unlinks it. The feature's
   * threads show it from their feature tag.
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
  /**
   * Reads the issue `ref` names for the project, as features link it: an issue link, `#56`, a
   * ticket's `T-<number>`, or a tracker key or link such as Linear's `LIN-123`.
   */
  readonly resolveIssue: (
    projectId: ProjectId,
    ref: string,
  ) => Effect.Effect<FeatureIssue, FeatureServiceError>;
  /** Links the issue `ref` names to a delegated task's thread itself; null unlinks it. */
  readonly setThreadIssue: (
    threadId: ThreadId,
    ref: string | null,
  ) => Effect.Effect<FeatureIssue | null, FeatureServiceError>;
  readonly get: (id: string) => Effect.Effect<FeatureRecord | null, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureRecord>, PersistenceSqlError>;
  /** Board cards for the project's features, newest first. */
  readonly board: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<FeatureBoardCard>, PersistenceSqlError>;
}

export class FeatureService extends Context.Service<FeatureService, FeatureServiceShape>()(
  "t3/features/FeatureService",
) {}

const validText = (value: string, max: number) => value.trim().length > 0 && value.length <= max;

const FEATURE_LEAD_RUN_PREFIX = "feature-lead";

/** How a child's report to its parent's lead opens, by what happened. */
const REPORT_HEADLINES = {
  finished: "Child feature finished",
  closed: "Child feature closed",
  stopped: "Child feature stopped without reporting",
  failed: "Child feature's lead failed",
  interrupted: "Child feature was interrupted",
} as const;
const QUIET_CHILD_HINT =
  "Its lead didn't call t3_feature_finish. If its work is done, carry on. If it asked something or needs a push, reply in its lead thread with t3_thread_send.";
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];
/**
 * Queued effects that lead to more work in a thread, whose events re-check it. Others, such as
 * capturing a checkpoint after a turn, settle without an event and mustn't hold a check back.
 */
const WORK_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.steer",
  "provider-runtime.continue",
  "runtime-request.respond",
];
const ENDED_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const hashed = (prefix: string, featureId: string, id: string) =>
  `${prefix}:${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([featureId, id]))
    .digest("hex")
    .slice(0, 32)}`;
/** The "feature-bot" prefix predates the Roles rename; existing member IDs keep it. */
const featureMemberId = (featureId: string, slot: string) => hashed("feature-bot", featureId, slot);

const assignmentsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeAssignments = Schema.encodeSync(assignmentsJson);
const decodeAssignments = Schema.decodeSync(assignmentsJson);
interface FeatureRow extends Omit<
  FeatureRecord,
  "crewAssignments" | "issue" | "number" | "briefAttachments" | "workflowId" | "parentFeatureId"
> {
  readonly number: number | null;
  readonly workflowId: string | null;
  readonly parentFeatureId: string | null;
  readonly briefMessageJson: string | null;
  readonly crewAssignmentsJson: string;
  readonly issueJson: string | null;
}

/**
 * Re-tags the threads working on a feature from its stored title and issue. With `renamedFrom`,
 * threads still named after that earlier title take the new one.
 */
const syncFeatureThreads = Effect.fn("FeatureService.syncFeatureThreads")(function* (
  featureId: string,
  renamedFrom: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const [feature] = yield* sql<{
    readonly projectId: string;
    readonly title: string;
    readonly issueJson: string | null;
    readonly requesterThreadId: ThreadId | null;
    readonly parentFeatureId: string | null;
  }>`
      SELECT project_id AS projectId, title, issue_json AS issueJson,
        requester_thread_id AS requesterThreadId, parent_feature_id AS parentFeatureId
      FROM features WHERE id = ${featureId}
    `;
  if (!feature) return;
  const tag = featureTag({
    id: featureId,
    title: feature.title,
    issue: decodeFeatureIssue(feature.issueJson),
    requesterThreadId: feature.requesterThreadId,
    parentFeatureId: feature.parentFeatureId,
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
export const generateFeatureTitle = Effect.fn("FeatureService.generateFeatureTitle")(
  function* (feature: FeatureRecord) {
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
  },
  (effect, feature) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Feature title generation failed", {
              featureId: feature.id,
              cause,
            }),
      ),
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
    const featureWorkspaces = yield* FeatureWorkspaces;
    const engine = yield* OrchestratorV2;
    const titleServices = yield* Effect.context<
      | ProjectStore.ProjectStoreV2
      | ServerSettings.ServerSettingsService
      | TextGeneration.TextGeneration
    >();
    const claimServices = yield* Effect.context<
      FileSystem.FileSystem | ServerConfig.ServerConfig | DocumentText.DocumentText
    >();
    const scope = yield* Effect.scope;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const queryError = toPersistenceSqlError("FeatureService.query");
    // Clients re-read the board when a feature's own record changes; thread changes they see.
    const { notify, notifying } = yield* crewChangeNotifier;
    const bumped = notifying("features");
    const decodeRow = (row: FeatureRow) =>
      Effect.try({
        try: () => {
          const {
            crewAssignmentsJson,
            issueJson,
            number,
            briefMessageJson,
            workflowId,
            parentFeatureId,
            ...feature
          } = row;
          return {
            ...feature,
            workflowId: workflowId ?? FEATURE_DELIVERY_WORKFLOW_ID,
            ...(parentFeatureId === null ? {} : { parentFeatureId }),
            ...(number != null ? { number } : {}),
            crewAssignments: decodeAssignments(crewAssignmentsJson),
            issue: decodeFeatureIssue(issueJson),
            briefAttachments: decodeOpeningMessage(briefMessageJson)?.attachments ?? [],
          };
        },
        catch: toPersistenceSqlError("FeatureService.decode"),
      });

    const get: FeatureServiceShape["get"] = (id) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, f.number,
          f.crew_assignments_json AS crewAssignmentsJson, f.issue_json AS issueJson,
          f.brief_message_json AS briefMessageJson, f.workflow_id AS workflowId,
          f.parent_feature_id AS parentFeatureId
        FROM features f
        WHERE f.id = ${id}
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => (rows[0] ? decodeRow(rows[0]) : Effect.succeed(null))),
      );

    const requireFeature = (id: string, projectId: ProjectId) =>
      get(id).pipe(
        Effect.filterOrFail(
          (feature): feature is NonNullable<typeof feature> =>
            feature !== null && feature.projectId === projectId,
          () => new FeatureValidationError("Feature not found in project"),
        ),
      );

    /** The bot that owns the project, once it can run: the crew is set up and it has a model. */
    const readyOwner = Effect.fn("FeatureService.readyOwner")(function* (
      projectId: ProjectId,
      action: string,
    ) {
      const ownerId = yield* bots.projectOwner(projectId);
      const owner = ownerId === null ? null : yield* bots.get(ownerId);
      if (!owner?.modelSelection) {
        return yield* Effect.fail(new FeatureValidationError(`Set up the crew before ${action}`));
      }
      return owner;
    });

    /** The names of the feature's crew members, as its lead addresses them. */
    const crewNames = Effect.fn("FeatureService.crewNames")(function* (feature: FeatureRecord) {
      const members = yield* Effect.forEach(Object.values(feature.crewAssignments), (id) =>
        crewStore.getMember(id),
      );
      return members.flatMap((member) => (member?.enabled ? [member.name] : []));
    });

    const requireWorkflow = Effect.fn("FeatureService.requireWorkflow")(function* (
      workflowId: string,
    ) {
      const exact = yield* crew.getWorkflow(workflowId);
      if (exact) return exact;
      // Agents name a workflow loosely: its ID without the prefix, or its name.
      const wanted = workflowId
        .trim()
        .toLowerCase()
        .replace(/^workflow:/, "");
      const workflows = yield* crew.listWorkflows();
      const match = workflows.find(
        (workflow) =>
          workflow.id.replace(/^workflow:/, "") === wanted ||
          workflow.name.trim().toLowerCase() === wanted,
      );
      if (match) return match;
      const known = workflows.map((workflow) => `${workflow.id} (${workflow.name})`).join(", ");
      return yield* Effect.fail(
        new FeatureValidationError(
          `Workflow not found: ${workflowId}. Use one of: ${known}, or leave workflowId out for Feature delivery.`,
        ),
      );
    });

    /**
     * The feature's lead: its workflow's lead role, in a run of its own in the feature's
     * worktree, with the workflow and brief as its first message. The run ID is fixed, so
     * starting again reuses it.
     */
    const startLead = Effect.fn("FeatureService.startLead")(function* (feature: FeatureRecord) {
      const workflow = yield* requireWorkflow(feature.workflowId ?? FEATURE_DELIVERY_WORKFLOW_ID);
      const manager = yield* crew.ensureProjectLead(feature.projectId, workflow.leadRoleId);
      if (!manager.enabled) {
        return yield* Effect.fail(new FeatureValidationError(`${manager.name} is unavailable`));
      }
      const workspace = yield* featureWorkspaces
        .forFeature(feature.id)
        .pipe(Effect.mapError((error) => new FeatureValidationError(error.message)));
      const [brief] = yield* sql<{
        readonly messageJson: string | null;
        readonly baseBranch: string | null;
        readonly requesterThreadId: ThreadId | null;
      }>`
        SELECT brief_message_json AS messageJson, base_branch AS baseBranch,
          requester_thread_id AS requesterThreadId
        FROM features WHERE id = ${feature.id}
      `.pipe(Effect.mapError(toPersistenceSqlError("FeatureService.startLead")));
      const runId = hashed(FEATURE_LEAD_RUN_PREFIX, feature.id, manager.id);
      // A lead started on older text keeps it: the run's task is part of its identity.
      const started = yield* crewStore.getRun(runId);
      const parent = feature.parentFeatureId ? yield* get(feature.parentFeatureId) : null;
      const run = yield* crew.createRun({
        id: runId,
        memberId: manager.id,
        projectId: feature.projectId,
        taskText:
          started?.taskText ??
          // Only a child's base matters to its lead; the composer always sends one.
          featureLeadTask(feature, workflow, yield* crewNames(feature), {
            parent,
            baseBranch: parent ? (brief?.baseBranch ?? null) : null,
          }),
        ...(workspace ? { workspace } : {}),
        openingMessage: decodeOpeningMessage(brief?.messageJson ?? null) ?? { attachments: [] },
        title: manager.name,
      });
      // A fixed command ID tags the thread once.
      yield* engine
        .dispatch({
          type: "thread.crew-stage.set",
          commandId: CommandId.make(`feature-lead:${run.id}:feature`),
          threadId: run.threadId,
          feature: featureTag({
            ...feature,
            requesterThreadId: brief?.requesterThreadId ?? null,
          }),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Lead thread tag failed", { runId: run.id, error }),
          ),
        );
      return { threadId: run.threadId, branch: run.workspace?.branch ?? null };
    });

    /**
     * The crew a feature's lead delegates to: a member of each enabled role in its workflow's
     * crew, each reporting to the workflow's lead.
     */
    const assembleCrew = Effect.fn("FeatureService.assembleCrew")(function* (
      featureId: string,
      projectId: ProjectId,
      workflow: Workflow,
    ) {
      const roles = (yield* Effect.forEach(workflow.crewRoleIds, (id) => crewStore.getRole(id)))
        .filter(Predicate.isNotNull)
        .filter((role) => role.enabled);
      const manager = yield* crew
        .ensureProjectLead(projectId, workflow.leadRoleId)
        .pipe(Effect.catchTags({ CrewValidationError: () => Effect.succeed(null) }));
      const bindings = new Map<string, string>();
      for (const [position, role] of roles.entries()) {
        const id = featureMemberId(featureId, role.id);
        if (yield* crewStore.getMember(id)) {
          return yield* Effect.fail(
            new FeatureValidationError("Feature crew member ID is already in use"),
          );
        }
        yield* crew.createMember({
          id,
          projectId,
          featureId,
          roleId: role.id,
          name: role.name,
          instructions: role.instructions,
          allowedTools: role.allowedTools,
          modelSelection: role.modelSelection,
          runtimeMode: role.runtimeMode,
        });
        bindings.set(role.id, id);
        if (manager?.enabled) {
          yield* crew.setHierarchyParent(id, manager.id, position);
          yield* crew.allowDelegation(manager.id, id);
        }
      }
      return Object.fromEntries(bindings);
    });

    const create: FeatureServiceShape["create"] = Effect.fn("FeatureService.create")(
      function* (input) {
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
        const requestHash = NodeCrypto.createHash("sha256")
          .update(
            encodeOpeningMessage({
              attachments: input.briefAttachments ?? [],
              ...(input.briefContext ? { context: input.briefContext } : {}),
            })!,
          )
          .digest("hex");
        const sameRequest = Effect.fn("FeatureService.sameRequest")(function* (
          existing: FeatureRecord,
        ) {
          const [row] = yield* sql<{
            readonly requestHash: string | null;
            readonly messageJson: string | null;
            readonly baseBranch: string | null;
          }>`
            SELECT brief_request_hash AS requestHash, brief_message_json AS messageJson,
              base_branch AS baseBranch
            FROM features WHERE id = ${existing.id}
          `.pipe(Effect.mapError(queryError));
          return (
            existing.projectId === input.projectId &&
            existing.parentFeatureId === input.parentFeatureId &&
            (row?.baseBranch ?? null) === (input.baseBranch?.trim() || null) &&
            existing.workflowId === (input.workflowId ?? FEATURE_DELIVERY_WORKFLOW_ID) &&
            (input.autoTitle || existing.title === input.title) &&
            existing.brief === input.brief &&
            (row?.requestHash === requestHash ||
              (row?.requestHash == null &&
                row?.messageJson == null &&
                (input.briefAttachments?.length ?? 0) === 0 &&
                (input.briefContext?.records.length ?? 0) === 0))
          );
        });
        const earlier = yield* get(input.id);
        if (earlier) {
          if (!(yield* sameRequest(earlier))) {
            return yield* Effect.fail(
              new FeatureValidationError("Feature ID belongs to another request"),
            );
          }
          return earlier;
        }
        const workflow = yield* requireWorkflow(input.workflowId ?? FEATURE_DELIVERY_WORKFLOW_ID);
        if (input.parentFeatureId !== undefined && (yield* get(input.parentFeatureId)) === null) {
          return yield* Effect.fail(new FeatureValidationError("Parent feature not found"));
        }
        // The brief's files belong to the feature, so they are claimed under its ID.
        const sent = input.briefAttachments ?? [];
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: input.id,
          attachments: sent,
        }).pipe(Effect.provideContext(claimServices));
        // Only the server attributes guests, so the brief keeps just its records.
        const records =
          remapComposerContextAttachments(
            input.briefContext,
            sent,
            claimed.attachments,
          )?.records.filter((record) => record.kind !== "guest" && record.kind !== "bot") ?? [];
        const openingMessage: OpeningMessage | null =
          claimed.attachments.length > 0 || records.length > 0
            ? {
                attachments: claimed.attachments,
                ...(records.length > 0 ? { context: { version: 1, records } } : {}),
              }
            : null;
        const { feature, created } = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const existing = yield* get(input.id);
              if (existing) {
                if (!(yield* sameRequest(existing))) {
                  return yield* Effect.fail(
                    new FeatureValidationError("Feature ID belongs to another request"),
                  );
                }
                return { feature: existing, created: false };
              }

              const crewAssignments = yield* assembleCrew(input.id, input.projectId, workflow);
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              // The number is taken in the insert itself, so concurrent creates cannot share one.
              const [inserted] = yield* sql<{ readonly number: number }>`
              INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, crew_assignments_json, workspace, base_branch, number, brief_message_json, brief_request_hash, workflow_id, parent_feature_id)
              VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt}, ${createdAt}, 'open', ${encodeAssignments(crewAssignments)}, ${input.workspace ?? "worktree"}, ${input.baseBranch?.trim() || null},
                (SELECT COALESCE(MAX(number), 0) + 1 FROM features WHERE project_id = ${input.projectId}), ${encodeOpeningMessage(openingMessage)}, ${requestHash}, ${workflow.id}, ${input.parentFeatureId ?? null})
              RETURNING number
            `;
              const {
                autoTitle: _autoTitle,
                workspace: _workspace,
                baseBranch: _baseBranch,
                briefAttachments: _briefAttachments,
                briefContext: _briefContext,
                workflowId: _workflowId,
                parentFeatureId,
                ...fields
              } = input;
              const feature: FeatureRecord = {
                ...fields,
                briefAttachments: claimed.attachments,
                crewAssignments,
                issue: null,
                workflowId: workflow.id,
                ...(parentFeatureId === undefined ? {} : { parentFeatureId }),
                createdAt,
                updatedAt: createdAt,
                status: "open",
                ...(inserted ? { number: inserted.number } : {}),
              };
              return { feature, created: true };
            }),
          )
          .pipe(
            Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }),
            Effect.tap(({ created }) =>
              created
                ? Effect.void
                : AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths),
            ),
            Effect.tapError(() => AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)),
            Effect.provideContext(claimServices),
          );
        // An issue linked in the brief comes first, so a generated title can read it.
        const issueUrl = created ? firstIssueRef(feature.brief) : null;
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
            // The board read the feature before its issue and title arrived.
            yield* notify("features");
          }).pipe(Effect.forkIn(scope));
        }
        return feature;
      },
    );

    const resolveIssue: FeatureServiceShape["resolveIssue"] = Effect.fn(
      "FeatureService.resolveIssue",
    )(function* (projectId, ref) {
      const ticketNumber = ticketNumberFromRef(ref);
      if (ticketNumber !== null) {
        const ticket = yield* readTicketByNumber(projectId, ticketNumber).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(queryError),
        );
        if (!ticket) {
          return yield* Effect.fail(
            new FeatureValidationError(`No ticket T-${ticketNumber} in this project`),
          );
        }
        return {
          url: "",
          ticketId: ticket.id,
          number: ticket.number,
          title: ticket.title.slice(0, 300),
          state: ticket.state,
          milestone: null,
          subIssues: null,
        } satisfies FeatureIssue;
      }
      const tracked = trackerIssue(ref);
      if (tracked !== null) return { ...tracked, title: tracked.title.slice(0, 300) };
      const project = yield* projects
        .get(projectId)
        .pipe(Effect.mapError(toPersistenceSqlError("FeatureService.resolveIssue")));
      const cwd = Option.isSome(project) ? project.value.workspaceRoot : null;
      const repositoryNumber = repositoryIssueNumber(ref);
      if (repositoryNumber !== null) {
        const handle =
          cwd === null
            ? null
            : yield* sourceControl.resolveHandle({ cwd }).pipe(Effect.orElseSucceed(() => null));
        const getIssue = handle?.provider.getIssue;
        if (cwd === null || getIssue === undefined) {
          return yield* Effect.fail(
            new FeatureValidationError("This project's host can't read issues. Paste a link"),
          );
        }
        const detail = yield* getIssue({ cwd, number: repositoryNumber }).pipe(
          Effect.mapError(
            () => new FeatureValidationError(`Issue #${repositoryNumber} could not be read`),
          ),
        );
        return {
          url: detail.url,
          number: detail.number,
          title: detail.title.slice(0, 300),
          state: detail.state,
          milestone: detail.milestone?.title ?? null,
          subIssues: detail.subIssues,
        } satisfies FeatureIssue;
      }
      const candidate = ref.trim();
      const url = URL.canParse(candidate) ? new URL(candidate) : null;
      const number = url ? issueNumberFromUrl(url) : null;
      if (!url || number === null) {
        return yield* Effect.fail(new FeatureValidationError("Paste a link to an issue"));
      }
      url.hash = "";
      url.search = "";
      const lookup = cwd === null ? undefined : sourceControl.resolveLink({ cwd, url });
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
      return {
        url: url.href,
        number,
        title: subject.title.slice(0, 300),
        state: subject.state ?? "open",
        milestone: subject.milestone ?? null,
        subIssues: subject.subIssues ?? null,
      } satisfies FeatureIssue;
    });

    const setIssue: FeatureServiceShape["setIssue"] = Effect.fn("FeatureService.setIssue")(
      function* (input) {
        const feature = yield* requireFeature(input.id, input.projectId);
        const issue = input.url === null ? null : yield* resolveIssue(feature.projectId, input.url);
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
      },
    );

    const start: FeatureServiceShape["start"] = Effect.fn("FeatureService.start")(
      function* (id, projectId) {
        const feature = yield* requireFeature(id, projectId);
        yield* readyOwner(projectId, "starting a feature");
        if (feature.status !== "open") {
          return yield* Effect.fail(
            new FeatureValidationError("Reopen the feature before starting it"),
          );
        }
        const lead = yield* startLead(feature);
        return { feature, leadThreadId: lead.threadId, branch: lead.branch };
      },
    );

    const launch: FeatureServiceShape["launch"] = Effect.fn("FeatureService.launch")(
      function* (input) {
        // Check the crew and base first, so a feature is never left made but unstarted.
        yield* readyOwner(input.projectId, "starting a feature");
        const baseBranch = input.baseBranch?.trim() || undefined;
        if (baseBranch !== undefined && input.workspace === "local") {
          return yield* Effect.fail(
            new FeatureValidationError(
              "A feature in the project's checkout can't start from another branch",
            ),
          );
        }
        if (baseBranch !== undefined) {
          yield* featureWorkspaces
            .requireBranch(input.projectId, baseBranch)
            .pipe(Effect.mapError((error) => new FeatureValidationError(error.message)));
        }
        // The stored ID, however the caller named it, so a retry is the same request.
        const workflow = input.workflowId ? yield* requireWorkflow(input.workflowId) : null;
        const feature = yield* create({
          id: input.featureId ?? `feature:${NodeCrypto.randomUUID()}`,
          projectId: input.projectId,
          title: input.title.trim(),
          brief: input.brief.trim(),
          ...(input.workspace ? { workspace: input.workspace } : {}),
          ...(workflow ? { workflowId: workflow.id } : {}),
          ...(baseBranch ? { baseBranch } : {}),
          ...(input.parentFeatureId ? { parentFeatureId: input.parentFeatureId } : {}),
        });
        // Before the lead starts, so its first stop finds who to tell; a retry keeps the first.
        if (input.requesterThreadId !== undefined) {
          yield* sql`
            UPDATE features SET requester_thread_id = ${input.requesterThreadId}
            WHERE id = ${feature.id} AND requester_thread_id IS NULL AND parent_feature_id IS NULL
          `.pipe(Effect.mapError(queryError));
        }
        return yield* start(feature.id, input.projectId).pipe(
          Effect.mapError(
            (error) =>
              new FeatureValidationError(
                `Feature ${feature.id} was created but didn't start: ${error.message}`,
              ),
          ),
        );
      },
    );

    const requesterThreadId: FeatureServiceShape["requesterThreadId"] = (featureId) =>
      sql<{ readonly threadId: string | null }>`
        SELECT requester_thread_id AS threadId FROM features WHERE id = ${featureId}
      `.pipe(
        Effect.mapError(queryError),
        Effect.map((rows) => (rows[0]?.threadId ? ThreadId.make(rows[0].threadId) : null)),
      );

    const crewMember: FeatureServiceShape["crewMember"] = Effect.fn("FeatureService.crewMember")(
      function* (featureId, name) {
        const feature = yield* get(featureId);
        if (!feature) return null;
        const wanted = name.trim().toLowerCase();
        for (const id of Object.values(feature.crewAssignments)) {
          const member = yield* crewStore.getMember(id);
          if (!member?.enabled) continue;
          if (member.name.toLowerCase() !== wanted && member.roleId?.toLowerCase() !== wanted)
            continue;
          return {
            name: member.name,
            instructions: member.instructions,
            modelSelection: member.modelSelection,
            runtimeMode: member.runtimeMode,
          };
        }
        return null;
      },
    );

    /** A feature's lead: its lead run's thread, else (before leads) its first top-level thread. */
    const leadThreadOf = (featureId: string) =>
      sql<{ readonly threadId: ThreadId }>`
        SELECT thread_id AS threadId FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.feature.id') = ${featureId}
          AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
        ORDER BY thread_id LIKE ${`bot-run:${FEATURE_LEAD_RUN_PREFIX}:%`} DESC, created_at, thread_id
        LIMIT 1
      `.pipe(
        Effect.mapError(queryError),
        Effect.map((rows) => rows[0]?.threadId ?? null),
      );

    /**
     * Tells a child's parent lead that the child finished or closed, as a message that wakes it
     * the way a crew result does. The reason it can't is returned instead: its parent is closed
     * or has no lead.
     */
    const reportToParent = Effect.fn("FeatureService.reportToParent")(function* (
      child: FeatureRecord,
      outcome: keyof typeof REPORT_HEADLINES,
      summary: string | null,
      /** Makes the message idempotent: one per key. */
      key: string = `feature-report:${NodeCrypto.randomUUID()}`,
    ) {
      const parent = child.parentFeatureId ? yield* get(child.parentFeatureId) : null;
      if (!parent) return "The parent feature is gone, so nobody was told";
      if (parent.status !== "open") return "The parent feature is closed, so its lead wasn't told";
      const parentLead = yield* leadThreadOf(parent.id);
      if (parentLead === null) return "The parent feature has no lead thread to tell";
      const parentShell = yield* engine
        .getThreadShell(parentLead)
        .pipe(Effect.orElseSucceed(() => null));
      if (parentShell?.archivedAt != null) return "The parent feature's lead thread is archived";
      const childLead = yield* leadThreadOf(child.id);
      const threadIds = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT thread_id AS threadId FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.feature.id') = ${child.id}
      `.pipe(Effect.mapError(queryError));
      const shells = (yield* Effect.forEach(threadIds, (row) =>
        engine.getThreadShell(row.threadId).pipe(Effect.orElseSucceed(() => null)),
      )).filter(Predicate.isNotNull);
      const lead = shells.find((shell) => shell.id === childLead);
      const pullRequests = [
        ...new Set(
          shells.flatMap((shell) =>
            [shell.linkedPullRequest?.url, shell.branchPullRequest?.url].filter(
              Predicate.isNotUndefined,
            ),
          ),
        ),
      ];
      // A person closing the child leaves no summary, so the lead's last word stands in.
      const said =
        summary ??
        (childLead === null
          ? null
          : yield* engine
              .getThreadRecords(childLead, ["messages"], { messageRoles: ["assistant"] })
              .pipe(
                Effect.map(({ messages }) => messages.at(-1)?.text ?? null),
                Effect.orElseSucceed(() => null),
              ));
      const ref = child.number === undefined ? child.id : `F-${child.number}, ${child.id}`;
      const text = [
        `${REPORT_HEADLINES[outcome]}: "${child.title}" (${ref})`,
        ...(outcome === "finished" || outcome === "closed" ? [] : [QUIET_CHILD_HINT]),
        `Branch: ${lead?.branch ?? "none, it works in the project's checkout"}`,
        `Pull request: ${pullRequests.length > 0 ? pullRequests.join(", ") : "none linked"}`,
        ...(childLead === null ? [] : [`Lead thread: ${childLead}`]),
        `Summary:\n${said?.trim().slice(0, 4_000) || "None given."}`,
      ].join("\n");
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId: parentLead,
          messageId: MessageId.make(key),
          ...(childLead === null ? {} : { senderThreadId: childLead }),
          text,
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: "queue_after_active" },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new FeatureValidationError(`The parent feature's lead wasn't told: ${error.message}`),
          ),
        );
      return null;
    });

    /**
     * Records how a feature's lead reported and during which of its runs; with `onlyFirst`,
     * false when it already reported since it opened.
     */
    const markReported = (
      featureId: string,
      reportedAt: string,
      onlyFirst: boolean,
      outcome: keyof typeof REPORT_HEADLINES,
      runId: string | null,
    ) =>
      sql<{ readonly id: string }>`
        UPDATE features SET reported_at = ${reportedAt}, report_outcome = ${outcome},
          reported_run_id = ${runId}
        WHERE id = ${featureId}
          AND (${onlyFirst ? 1 : 0} = 0 OR reported_at IS NULL)
        RETURNING id
      `.pipe(
        Effect.mapError(queryError),
        Effect.map((rows) => rows.length > 0),
        Effect.tap((marked) => (marked ? notify("features") : Effect.void)),
      );

    const listByProject: FeatureServiceShape["listByProject"] = (projectId) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, f.number,
          f.crew_assignments_json AS crewAssignmentsJson, f.issue_json AS issueJson,
          f.brief_message_json AS briefMessageJson, f.workflow_id AS workflowId,
          f.parent_feature_id AS parentFeatureId
        FROM features f
        WHERE f.project_id = ${projectId}
        ORDER BY f.created_at DESC, f.id DESC
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    /**
     * A lead's turn as its thread shell sees it, which clients read too: the run executing now,
     * else its latest, never a queued follow-up or a silent idle compaction.
     */
    const leadTurnOf = (threadId: ThreadId) =>
      engine.getThreadShell(threadId).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((shell) => {
          const runId = shell?.activeRunId ?? shell?.latestRunId ?? null;
          return shell && runId
            ? { runId, ended: shell.activeRunId === null, status: shell.status }
            : null;
        }),
      );

    /** Open child features with an open parent: the ones that report to a lead. */
    const reportingChildren = sql<{ readonly id: string }>`
      SELECT child.id FROM features AS child
      JOIN features AS parent ON parent.id = child.parent_feature_id
      WHERE child.status = 'open' AND parent.status = 'open'
    `.pipe(Effect.mapError(queryError));

    const reportIfQuiet: FeatureServiceShape["reportIfQuiet"] = Effect.fn(
      "FeatureService.reportIfQuiet",
    )(function* (threadId) {
      const [tag] = yield* sql<{ readonly featureId: string | null }>`
        SELECT json_extract(payload_json, '$.feature.id') AS featureId
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `.pipe(Effect.mapError(queryError));
      const feature = tag?.featureId ? yield* get(tag.featureId) : null;
      if (!feature?.parentFeatureId || feature.status !== "open") return;
      const lead = yield* leadThreadOf(feature.id);
      if (lead === null) return;
      // Quiet: none of its threads runs, waits on the person, has work queued for it (such as
      // resuming a turn a restart cut short), or owes its lead a crew result not yet delivered.
      const busy = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_threads AS t
        WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
          AND json_extract(t.payload_json, '$.feature.id') = ${feature.id}
          AND (
            EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS r
              WHERE r.thread_id = t.thread_id AND r.status IN ${sql.in(ACTIVE_RUN_STATUSES)})
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests AS q
              WHERE q.thread_id = t.thread_id AND q.status = 'pending')
            OR EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox AS e
              WHERE e.thread_id = t.thread_id AND e.status IN ('pending', 'running')
                AND e.effect_type IN ${sql.in(WORK_EFFECT_TYPES)})
            OR EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents AS a
              WHERE a.thread_id = t.thread_id
                AND a.completion_delivery_state IN ('pending', 'claimed'))
          )
        LIMIT 1
      `.pipe(Effect.mapError(queryError));
      if (busy.length > 0) return;
      const run = yield* leadTurnOf(lead);
      if (!run?.ended) return;
      const [marker] = yield* sql<{ readonly runId: string | null }>`
        SELECT reported_run_id AS runId FROM features WHERE id = ${feature.id}
      `.pipe(Effect.mapError(queryError));
      // Reported during this run, by t3_feature_finish or an earlier quiet report.
      if (marker?.runId === run.runId) return;
      const outcome =
        run.status === "failed"
          ? "failed"
          : run.status === "cancelled" || run.status === "interrupted"
            ? "interrupted"
            : "stopped";
      const undelivered = yield* reportToParent(
        feature,
        outcome,
        null,
        `feature-quiet:${run.runId}`,
      );
      if (undelivered === null) {
        yield* markReported(
          feature.id,
          DateTime.formatIso(yield* DateTime.now),
          false,
          outcome,
          run.runId,
        );
      }
    });

    const withdrawFinished: FeatureServiceShape["withdrawFinished"] = (threadId, sentAt) =>
      sql`
        UPDATE features SET reported_at = NULL, report_outcome = NULL, reported_run_id = NULL
        WHERE report_outcome = 'finished' AND reported_at < ${sentAt}
          AND id = (
            SELECT json_extract(payload_json, '$.feature.id')
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
              AND json_extract(payload_json, '$.feature.member') IS NULL
              AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
          )
        RETURNING id
      `.pipe(
        Effect.flatMap((rows) => (rows.length > 0 ? notify("features") : Effect.void)),
        Effect.catch((error) =>
          Effect.logWarning("Clearing a finished report failed", { threadId, error }),
        ),
      );

    const reconcileChildren: FeatureServiceShape["reconcileChildren"] = Effect.fn(
      "FeatureService.reconcileChildren",
    )(function* () {
      // One child failing to check doesn't keep the others from theirs.
      for (const child of yield* reportingChildren) {
        yield* leadThreadOf(child.id).pipe(
          Effect.flatMap((lead) => (lead === null ? Effect.void : reportIfQuiet(lead))),
          Effect.catch((error) =>
            Effect.logWarning("Checking a quiet child feature failed", {
              featureId: child.id,
              error,
            }),
          ),
        );
      }
    });

    return FeatureService.of({
      start,
      setIssue: bumped(setIssue),
      launch: bumped(launch),
      requesterThreadId,
      reportingLeads: sql<{ readonly id: string }>`
        SELECT id FROM features WHERE requester_thread_id IS NOT NULL AND status = 'open'
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => leadThreadOf(row.id))),
        Effect.map((leads) => leads.filter(Predicate.isNotNull)),
      ),
      projectBot: bots.projectOwner,
      reportIfQuiet,
      reconcileChildren,
      withdrawFinished,
      watchChildren: Effect.fn("FeatureService.watchChildren")(function* () {
        const check = (threadId: ThreadId) =>
          reportIfQuiet(threadId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Checking a quiet child feature failed", { threadId, error }),
            ),
          );
        const onEvent = (event: OrchestrationV2DomainEvent) => {
          switch (event.type) {
            case "run.updated":
              return ENDED_RUN_STATUSES.has(event.payload.status)
                ? check(event.threadId)
                : Effect.void;
            // A question answered or dismissed, or a crew result delivered, can leave it quiet.
            case "runtime-request.updated":
              return event.payload.status === "pending" ? Effect.void : check(event.threadId);
            case "subagent.updated":
              return check(event.threadId);
            case "message.updated":
              return event.payload.role === "user" && idleCompactionOf(event.payload) === undefined
                ? withdrawFinished(event.threadId, DateTime.formatIso(event.payload.createdAt))
                : Effect.void;
            default:
              return Effect.void;
          }
        };
        // Each (re)start catches up on children that went quiet while it wasn't watching, then
        // follows events from before that scan (or from where it stopped), so none slip between.
        const cursor = yield* Ref.make<number | null>(null);
        const watch = Effect.gen(function* () {
          const [latest] = yield* sql<{ readonly sequence: number }>`
            SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
          `;
          const from = (yield* Ref.get(cursor)) ?? latest?.sequence ?? 0;
          yield* reconcileChildren().pipe(Effect.ignore);
          yield* engine
            .streamStoredEventsFrom({ afterSequence: from })
            .pipe(
              Stream.runForEach((stored) =>
                onEvent(stored.event).pipe(Effect.andThen(Ref.set(cursor, stored.sequence))),
              ),
            );
        });
        yield* watch.pipe(
          Effect.retry(Schedule.spaced("5 seconds")),
          Effect.catchCause((cause) => Effect.logWarning("Child feature watch stopped", { cause })),
          Effect.forkScoped,
        );
      }),
      finishForThread: Effect.fn("FeatureService.finishForThread")(function* (threadId, summary) {
        const [thread] = yield* sql<{
          readonly featureId: string | null;
          readonly member: string | null;
          readonly parentThreadId: string | null;
        }>`
          SELECT json_extract(payload_json, '$.feature.id') AS featureId,
            json_extract(payload_json, '$.feature.member') AS member,
            json_extract(payload_json, '$.lineage.parentThreadId') AS parentThreadId
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `.pipe(Effect.mapError(queryError));
        const feature = thread?.featureId ? yield* get(thread.featureId) : null;
        if (!feature || thread?.member !== null || thread.parentThreadId !== null) {
          return yield* Effect.fail(
            new FeatureValidationError("Only a feature's lead can report it done"),
          );
        }
        if (!validText(summary, 16_000)) {
          return yield* Effect.fail(new FeatureValidationError("Give a short summary"));
        }
        // A child's parent hears; any feature's board then reads it as finished.
        if (feature.parentFeatureId) {
          const undelivered = yield* reportToParent(feature, "finished", summary);
          if (undelivered !== null)
            return yield* Effect.fail(new FeatureValidationError(undelivered));
        }
        const run = yield* leadTurnOf(threadId);
        yield* markReported(
          feature.id,
          DateTime.formatIso(yield* DateTime.now),
          false,
          "finished",
          run?.runId ?? null,
        );
        return feature;
      }),
      crewMember,
      crewMemberNames: Effect.fn("FeatureService.crewMemberNames")(function* (featureId) {
        const feature = yield* get(featureId);
        return feature ? yield* crewNames(feature) : [];
      }),
      setIssueForThread: Effect.fn("FeatureService.setIssueForThread")(function* (threadId, url) {
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
        return yield* bumped(setIssue)({ id: thread.featureId, projectId: thread.projectId, url });
      }),
      resolveIssue,
      setThreadIssue: Effect.fn("FeatureService.setThreadIssue")(function* (threadId, ref) {
        const [thread] = yield* sql<{ readonly projectId: ProjectId }>`
            SELECT project_id AS projectId FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} AND deleted_at IS NULL
          `.pipe(Effect.mapError(queryError));
        if (!thread) return yield* Effect.fail(new FeatureValidationError("Thread not found"));
        const issue = ref === null ? null : yield* resolveIssue(thread.projectId, ref);
        yield* engine
          .dispatch({
            type: "thread.crew-stage.set",
            commandId: CommandId.make(`task-issue:${NodeCrypto.randomUUID()}`),
            threadId,
            issue,
          })
          .pipe(Effect.mapError((error) => new FeatureValidationError(String(error))));
        return issue;
      }),
      get,
      setStatus: Effect.fn("FeatureService.setStatus")(function* (id, projectId, status) {
        const feature = yield* sql
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
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              // Reopening means its parent hears again when it next finishes.
              yield* sql`UPDATE features SET status = ${status}, updated_at = ${updatedAt},
                reported_at = CASE WHEN ${status} = 'open' THEN NULL ELSE reported_at END,
                report_outcome = CASE WHEN ${status} = 'open' THEN NULL ELSE report_outcome END,
                reported_run_id = CASE WHEN ${status} = 'open' THEN NULL ELSE reported_run_id END
              WHERE id = ${id} AND project_id = ${projectId}`;
              return { ...feature, status, updatedAt };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) }));
        // A child closed before its lead reported it done reports as it closes, and counts as
        // reported only once its parent's lead has the message; closing it again retries.
        if (status === "closed" && feature.parentFeatureId) {
          const [row] = yield* sql<{ readonly reportedAt: string | null }>`
            SELECT reported_at AS reportedAt FROM features WHERE id = ${feature.id}
          `.pipe(Effect.mapError(queryError));
          if (row && row.reportedAt === null) {
            const undelivered = yield* reportToParent(feature, "closed", null).pipe(
              Effect.catch((error) => Effect.succeed(error.message)),
            );
            if (undelivered === null)
              yield* markReported(feature.id, feature.updatedAt, true, "closed", null);
            else
              yield* Effect.logWarning("A closed child feature's report wasn't delivered", {
                featureId: feature.id,
                reason: undelivered,
              });
          }
        }
        yield* notify("features");
        return feature;
      }),
      listByProject,
      board: Effect.fn("FeatureService.board")(function* (projectId) {
        const records = yield* listByProject(projectId);
        // A feature's lead is its lead run's thread; features from before leads use their
        // first top-level thread. Crew threads hang under the lead.
        const leads = yield* sql<{ readonly featureId: string; readonly threadId: ThreadId }>`
          SELECT featureId, threadId FROM (
            SELECT json_extract(payload_json, '$.feature.id') AS featureId, thread_id AS threadId,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.feature.id')
                ORDER BY thread_id LIKE ${`bot-run:${FEATURE_LEAD_RUN_PREFIX}:%`} DESC,
                  created_at, thread_id
              ) AS rank
            FROM orchestration_v2_projection_threads
            WHERE project_id = ${projectId} AND deleted_at IS NULL
              AND json_extract(payload_json, '$.feature.id') IS NOT NULL
              AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
          ) WHERE rank = 1
        `.pipe(Effect.mapError(queryError));
        const leadByFeature = new Map(leads.map((lead) => [lead.featureId, lead.threadId]));
        const reports = yield* sql<{
          readonly id: string;
          readonly outcome: keyof typeof REPORT_HEADLINES;
          readonly runId: string | null;
        }>`
          SELECT id, report_outcome AS outcome, reported_run_id AS runId FROM features
          WHERE project_id = ${projectId} AND report_outcome IS NOT NULL
        `.pipe(Effect.mapError(queryError));
        const reportByFeature = new Map(
          reports.map((report) => [report.id, { outcome: report.outcome, runId: report.runId }]),
        );
        return records.map((feature): FeatureBoardCard => {
          const report = reportByFeature.get(feature.id);
          return {
            featureId: feature.id,
            projectId: feature.projectId,
            title: feature.title,
            ...(feature.number === undefined ? {} : { number: feature.number }),
            issue: feature.issue,
            status: feature.status,
            leadThreadId: leadByFeature.get(feature.id) ?? null,
            ...(feature.parentFeatureId === undefined
              ? {}
              : { parentFeatureId: feature.parentFeatureId }),
            ...(report ? { report } : {}),
            createdAt: feature.createdAt,
            updatedAt: feature.updatedAt,
          };
        });
      }),
      create: bumped(create),
    });
  }),
);
