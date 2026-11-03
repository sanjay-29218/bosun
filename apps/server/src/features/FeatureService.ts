// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type FeatureBoardCard,
  type FeatureCreateInput,
  type FeatureRecord as FeatureRecordSchema,
  type FeatureWorkspace,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BotStore from "../bots/BotStore.ts";
import { FeatureWorkspaces } from "./FeatureWorkspaces.ts";
import { CrewService, type CrewServiceError } from "../crew/CrewService.ts";
import { CrewStore } from "../crew/CrewStore.ts";
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
} from "./featureIssue.ts";
import { readTicketByNumber, ticketNumberFromRef } from "../tickets/ticketRows.ts";
class FeatureValidationError extends Error {
  readonly _tag = "FeatureValidationError";
}

export type FeatureRecord = typeof FeatureRecordSchema.Type;
export type CreateFeatureInput = typeof FeatureCreateInput.Type;

export type FeatureServiceError =
  | FeatureValidationError
  | AttachmentClaims.AttachmentClaimError
  | CrewServiceError
  | PersistenceSqlError;

export interface FeatureStartResult {
  readonly feature: FeatureRecord;
  readonly leadThreadId: ThreadId;
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
  /** Creates a feature and starts it. A retry with the same `featureId` returns the same one. */
  readonly launch: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly brief: string;
    readonly featureId?: string | undefined;
    readonly workspace?: FeatureWorkspace | undefined;
  }) => Effect.Effect<FeatureStartResult, FeatureServiceError>;
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
  "crewAssignments" | "issue" | "number" | "briefAttachments"
> {
  readonly number: number | null;
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
    const decodeRow = (row: FeatureRow) =>
      Effect.try({
        try: () => {
          const { crewAssignmentsJson, issueJson, number, briefMessageJson, ...feature } = row;
          return {
            ...feature,
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
          f.brief_message_json AS briefMessageJson
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

    /**
     * The feature's lead: the project manager, in a run of its own in the feature's worktree,
     * with the brief as its first message. The run ID is fixed, so starting again reuses it.
     */
    const startLead = Effect.fn("FeatureService.startLead")(function* (feature: FeatureRecord) {
      const manager = yield* crew.ensureProjectManager(feature.projectId);
      if (!manager.enabled) {
        return yield* Effect.fail(new FeatureValidationError("The project manager is unavailable"));
      }
      const workspace = yield* featureWorkspaces
        .forFeature(feature.id)
        .pipe(Effect.mapError((error) => new FeatureValidationError(error.message)));
      const [brief] = yield* sql<{ readonly messageJson: string | null }>`
        SELECT brief_message_json AS messageJson FROM features WHERE id = ${feature.id}
      `.pipe(Effect.mapError(toPersistenceSqlError("FeatureService.startLead")));
      const run = yield* crew.createRun({
        id: hashed("feature-lead", feature.id, manager.id),
        memberId: manager.id,
        projectId: feature.projectId,
        taskText: featureLeadTask(feature, yield* crewNames(feature)),
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
          feature: featureTag(feature),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Lead thread tag failed", { runId: run.id, error }),
          ),
        );
      return run.threadId;
    });

    /**
     * The crew a feature's lead delegates to: a member of every role that joins features, each
     * reporting to the project's manager. The manager itself is the lead and isn't copied.
     */
    const assembleCrew = Effect.fn("FeatureService.assembleCrew")(function* (
      featureId: string,
      projectId: ProjectId,
    ) {
      const roles = (yield* crewStore.listRoles()).filter(
        (role) => role.enabled && role.autoCreateForFeature,
      );
      const manager = yield* crew
        .ensureProjectManager(projectId)
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
          }>`
            SELECT brief_request_hash AS requestHash, brief_message_json AS messageJson FROM features WHERE id = ${existing.id}
          `.pipe(Effect.mapError(queryError));
          return (
            existing.projectId === input.projectId &&
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

              const crewAssignments = yield* assembleCrew(input.id, input.projectId);
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              // The number is taken in the insert itself, so concurrent creates cannot share one.
              const [inserted] = yield* sql<{ readonly number: number }>`
              INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, crew_assignments_json, workspace, base_branch, number, brief_message_json, brief_request_hash)
              VALUES (${input.id}, ${input.projectId}, ${input.title}, ${input.brief}, ${createdAt}, ${createdAt}, 'open', ${encodeAssignments(crewAssignments)}, ${input.workspace ?? "worktree"}, ${input.baseBranch?.trim() || null},
                (SELECT COALESCE(MAX(number), 0) + 1 FROM features WHERE project_id = ${input.projectId}), ${encodeOpeningMessage(openingMessage)}, ${requestHash})
              RETURNING number
            `;
              const {
                autoTitle: _autoTitle,
                workspace: _workspace,
                baseBranch: _baseBranch,
                briefAttachments: _briefAttachments,
                briefContext: _briefContext,
                ...fields
              } = input;
              const feature: FeatureRecord = {
                ...fields,
                briefAttachments: claimed.attachments,
                crewAssignments,
                issue: null,
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
          }).pipe(Effect.forkIn(scope));
        }
        return feature;
      },
    );

    const setIssue: FeatureServiceShape["setIssue"] = Effect.fn("FeatureService.setIssue")(
      function* (input) {
        const feature = yield* requireFeature(input.id, input.projectId);
        let issue: FeatureRecord["issue"] = null;
        const ticketNumber = input.url === null ? null : ticketNumberFromRef(input.url);
        if (ticketNumber !== null) {
          const ticket = yield* readTicketByNumber(feature.projectId, ticketNumber).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(queryError),
          );
          if (!ticket) {
            return yield* Effect.fail(
              new FeatureValidationError(`No ticket T-${ticketNumber} in this project`),
            );
          }
          issue = {
            url: "",
            ticketId: ticket.id,
            number: ticket.number,
            title: ticket.title.slice(0, 300),
            state: ticket.state,
            milestone: null,
            subIssues: null,
          };
        } else if (input.url !== null) {
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
        return { feature, leadThreadId: yield* startLead(feature) };
      },
    );

    const launch: FeatureServiceShape["launch"] = Effect.fn("FeatureService.launch")(
      function* (input) {
        // Check the crew first, so a feature is never left made but unstarted.
        yield* readyOwner(input.projectId, "starting a feature");
        const feature = yield* create({
          id: input.featureId ?? `feature:${NodeCrypto.randomUUID()}`,
          projectId: input.projectId,
          title: input.title.trim(),
          brief: input.brief.trim(),
          ...(input.workspace ? { workspace: input.workspace } : {}),
        });
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

    const listByProject: FeatureServiceShape["listByProject"] = (projectId) =>
      sql<FeatureRow>`
        SELECT f.id, f.project_id AS projectId, f.title, f.brief, f.created_at AS createdAt,
          f.updated_at AS updatedAt, f.status, f.number,
          f.crew_assignments_json AS crewAssignmentsJson, f.issue_json AS issueJson,
          f.brief_message_json AS briefMessageJson
        FROM features f
        WHERE f.project_id = ${projectId}
        ORDER BY f.created_at DESC, f.id DESC
      `.pipe(
        Effect.mapError(queryError),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    return FeatureService.of({
      start,
      setIssue,
      launch,
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
        return yield* setIssue({ id: thread.featureId, projectId: thread.projectId, url });
      }),
      get,
      setStatus: Effect.fn("FeatureService.setStatus")((id, projectId, status) =>
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
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`UPDATE features SET status = ${status}, updated_at = ${updatedAt}
            WHERE id = ${id} AND project_id = ${projectId}`;
              return { ...feature, status, updatedAt };
            }),
          )
          .pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(queryError(error)) })),
      ),
      listByProject,
      board: Effect.fn("FeatureService.board")(function* (projectId) {
        const records = yield* listByProject(projectId);
        // A feature's lead is its first top-level thread: crew threads hang under it.
        const leads = yield* sql<{ readonly featureId: string; readonly threadId: ThreadId }>`
          SELECT json_extract(payload_json, '$.feature.id') AS featureId, thread_id AS threadId,
            MIN(created_at) AS createdAt
          FROM orchestration_v2_projection_threads
          WHERE project_id = ${projectId} AND deleted_at IS NULL
            AND json_extract(payload_json, '$.feature.id') IS NOT NULL
            AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
          GROUP BY featureId
        `.pipe(Effect.mapError(queryError));
        const leadByFeature = new Map(leads.map((lead) => [lead.featureId, lead.threadId]));
        return records.map((feature): FeatureBoardCard => ({
          featureId: feature.id,
          projectId: feature.projectId,
          title: feature.title,
          ...(feature.number === undefined ? {} : { number: feature.number }),
          issue: feature.issue,
          status: feature.status,
          leadThreadId: leadByFeature.get(feature.id) ?? null,
          createdAt: feature.createdAt,
          updatedAt: feature.updatedAt,
        }));
      }),
      create,
    });
  }),
);
