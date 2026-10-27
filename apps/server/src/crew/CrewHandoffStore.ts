import {
  CrewHandoff as CrewHandoffContract,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

const StoredCrewHandoff = Schema.Struct({
  ...CrewHandoffContract.fields,
  notificationState: Schema.Literals(["none", "queued", "delivered"]),
  noticeVersion: Schema.Int,
  attempt: Schema.Int,
});

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(StoredCrewHandoff));
const decodeHandoff = Schema.decodeSync(Schema.fromJsonString(StoredCrewHandoff));

export type CrewHandoffStatus =
  | "queued"
  | "running"
  | "completed"
  | "needs-input"
  | "failed"
  | "cancelled";

export interface CrewHandoff {
  readonly id: string;
  readonly parentId: string | null;
  readonly sourceRunId: string;
  readonly targetMemberId: string;
  readonly targetRunId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
  readonly contextText: string;
  readonly depth: number;
  readonly status: CrewHandoffStatus;
  readonly responseText: string | null;
  readonly questionText: string | null;
  readonly lastError: string | null;
  readonly notificationState: "none" | "queued" | "delivered";
  readonly noticeVersion: number;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Overrides the target bot's model for the run this handoff starts. Not part of receipts. */
  readonly modelSelection?: ModelSelection | null;
}

interface HandoffRow extends Omit<CrewHandoff, "projectId" | "modelSelection"> {
  readonly projectId: string;
  readonly modelSelectionJson: string | null;
}

const modelSelectionJson = Schema.fromJsonString(ModelSelection);
const encodeModelSelection = Schema.encodeSync(modelSelectionJson);
const decodeModelSelection = Schema.decodeSync(modelSelectionJson);

const columns = `
  id, parent_id AS parentId, source_run_id AS sourceRunId,
  target_member_id AS targetMemberId, target_run_id AS targetRunId,
  project_id AS projectId, task_text AS taskText, context_text AS contextText,
  depth, status, response_text AS responseText, question_text AS questionText,
  last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
  , notification_state AS notificationState, notice_version AS noticeVersion, attempt
  , model_selection_json AS modelSelectionJson
`;

const decode = ({ modelSelectionJson, ...row }: HandoffRow): CrewHandoff => ({
  ...row,
  projectId: ProjectId.make(row.projectId),
  modelSelection: modelSelectionJson === null ? null : decodeModelSelection(modelSelectionJson),
});

export interface CrewHandoffReceipt {
  readonly sequence: number;
  readonly handoff: CrewHandoff;
}

export interface CrewHandoffStoreShape {
  readonly subscribeChanges: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
  readonly listReceipts: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<CrewHandoffReceipt>, PersistenceSqlError>;
  readonly insert: (handoff: CrewHandoff) => Effect.Effect<void, PersistenceSqlError>;
  readonly get: (id: string) => Effect.Effect<CrewHandoff | null, PersistenceSqlError>;
  readonly getForTargetRun: (
    runId: string,
  ) => Effect.Effect<CrewHandoff | null, PersistenceSqlError>;
  readonly listBySourceRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listPending: () => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listUndelivered: () => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listUndeliveredByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listRunning: () => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listRunningByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly listAncestors: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<CrewHandoff>, PersistenceSqlError>;
  readonly transition: (
    id: string,
    from: ReadonlyArray<CrewHandoffStatus>,
    to: CrewHandoffStatus,
    at: string,
    fields?: {
      readonly responseText?: string | null;
      readonly questionText?: string | null;
      readonly lastError?: string | null;
    },
    notify?: boolean,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly markDelivered: (id: string, version: number) => Effect.Effect<void, PersistenceSqlError>;
  readonly retry: (id: string, at: string) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getRunByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, PersistenceSqlError>;
}

export class CrewHandoffStore extends Context.Service<CrewHandoffStore, CrewHandoffStoreShape>()(
  "t3/crew/CrewHandoffStore",
) {}

export const CrewHandoffStoreLive = Layer.effect(
  CrewHandoffStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const error = toPersistenceSqlError("CrewHandoffStore.query");
    const changes = yield* PubSub.unbounded<string>();
    const get = (id: string) =>
      sql<HandoffRow>`SELECT ${sql.unsafe(columns)} FROM crew_handoffs WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
        Effect.mapError(error),
      );
    const receipt = Effect.fn("CrewHandoffStore.receipt")(function* (id: string) {
      const handoff = yield* get(id);
      if (handoff)
        yield* sql`
        INSERT INTO crew_handoff_receipts (handoff_id, handoff_json)
        VALUES (${id}, ${encodeHandoff(handoff)})
      `;
    });
    const mutate = <A>(
      id: string,
      operation: Effect.Effect<ReadonlyArray<A>, import("effect/sql/SqlError").SqlError>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* operation;
            if (rows.length > 0) yield* receipt(id);
            return rows.length > 0;
          }),
        )
        .pipe(
          Effect.mapError(error),
          Effect.tap((changed) => (changed ? PubSub.publish(changes, id) : Effect.void)),
        );
    return {
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      listReceipts: (id) =>
        sql<{ readonly sequence: number; readonly handoffJson: string }>`
        SELECT sequence, handoff_json AS handoffJson FROM crew_handoff_receipts
        WHERE handoff_id = ${id} ORDER BY sequence
      `.pipe(
          Effect.mapError(error),
          Effect.flatMap((rows) =>
            Effect.try({
              try: () =>
                rows.map((row) => ({
                  sequence: row.sequence,
                  handoff: decodeHandoff(row.handoffJson),
                })),
              catch: (cause) => toPersistenceSqlError("CrewHandoffStore.decodeReceipt")(cause),
            }),
          ),
        ),
      insert: (handoff) =>
        mutate(
          handoff.id,
          sql<{ readonly id: string }>`
          INSERT OR IGNORE INTO crew_handoffs (
            id, parent_id, source_run_id, target_member_id, target_run_id, project_id,
            task_text, context_text, depth, status, response_text, question_text,
            last_error, notification_state, notice_version, attempt, created_at, updated_at,
            model_selection_json
          ) VALUES (
            ${handoff.id}, ${handoff.parentId}, ${handoff.sourceRunId}, ${handoff.targetMemberId},
            ${handoff.targetRunId}, ${handoff.projectId}, ${handoff.taskText},
            ${handoff.contextText}, ${handoff.depth}, ${handoff.status},
            ${handoff.responseText}, ${handoff.questionText}, ${handoff.lastError},
            ${handoff.notificationState}, ${handoff.noticeVersion}, ${handoff.attempt},
            ${handoff.createdAt}, ${handoff.updatedAt},
            ${handoff.modelSelection ? encodeModelSelection(handoff.modelSelection) : null}
          )
          RETURNING id
        `,
        ).pipe(Effect.asVoid),
      get,
      getForTargetRun: (runId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE target_run_id = ${runId}
        `.pipe(
          Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
          Effect.mapError(error),
        ),
      listBySourceRun: (runId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE source_run_id = ${runId} ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listByProject: (projectId, limit) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE project_id = ${projectId} AND (
            status IN ('queued', 'running', 'needs-input') OR id IN (
              SELECT id FROM crew_handoffs
              WHERE project_id = ${projectId}
              ORDER BY created_at DESC, id DESC LIMIT ${limit}
            )
          )
          ORDER BY created_at DESC, id DESC
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listPending: () =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE status = 'queued' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listUndelivered: () =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE notification_state = 'queued' ORDER BY updated_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listUndeliveredByProject: (projectId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE project_id = ${projectId} AND notification_state = 'queued'
          ORDER BY updated_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listRunning: () =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE status = 'running' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listRunningByProject: (projectId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE project_id = ${projectId} AND status = 'running' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listAncestors: (id) =>
        sql<HandoffRow>`
          WITH RECURSIVE lineage(id, parent_id) AS (
            SELECT id, parent_id FROM crew_handoffs WHERE id = ${id}
            UNION ALL
            SELECT h.id, h.parent_id FROM crew_handoffs AS h
            JOIN lineage AS l ON h.id = l.parent_id
          )
          SELECT ${sql.unsafe(columns)} FROM crew_handoffs
          WHERE id IN (SELECT id FROM lineage)
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      transition: (id, from, to, at, fields, notify = false) =>
        mutate(
          id,
          sql<{ readonly id: string }>`
          UPDATE crew_handoffs SET
            status = ${to}, updated_at = ${at},
            response_text = ${fields?.responseText ?? null},
            question_text = ${fields?.questionText ?? null},
            last_error = ${fields?.lastError ?? null},
            notification_state = CASE WHEN ${notify ? 1 : 0} = 1 THEN 'queued' ELSE notification_state END,
            notice_version = notice_version + ${notify ? 1 : 0}
          WHERE id = ${id} AND ${sql.in("status", from)} RETURNING id
        `,
        ),
      markDelivered: (id, version) =>
        sql`
          UPDATE crew_handoffs SET notification_state = 'delivered'
          WHERE id = ${id} AND notice_version = ${version} AND notification_state = 'queued'
        `.pipe(Effect.asVoid, Effect.mapError(error)),
      retry: (id, at) =>
        mutate(
          id,
          sql<{ readonly id: string }>`
          UPDATE crew_handoffs SET
            status = 'queued', attempt = attempt + 1,
            target_run_id = 'bot-handoff:' || id || ':attempt:' || (attempt + 1),
            response_text = NULL, question_text = NULL, last_error = NULL,
            notification_state = 'none', updated_at = ${at}
          WHERE id = ${id} AND status IN ('failed', 'cancelled') AND attempt < 10
          RETURNING id
        `,
        ),
      getRunByThread: (threadId) =>
        sql<{ readonly id: string }>`
          SELECT id FROM crew_runs WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => rows[0]?.id ?? null),
          Effect.mapError(error),
        ),
    } satisfies CrewHandoffStoreShape;
  }),
);
