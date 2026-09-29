import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

export type BotHandoffStatus =
  | "queued"
  | "running"
  | "completed"
  | "needs-input"
  | "failed"
  | "cancelled";

export interface BotHandoff {
  readonly id: string;
  readonly parentId: string | null;
  readonly sourceRunId: string;
  readonly targetBotId: string;
  readonly targetRunId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
  readonly contextText: string;
  readonly depth: number;
  readonly status: BotHandoffStatus;
  readonly responseText: string | null;
  readonly questionText: string | null;
  readonly lastError: string | null;
  readonly notificationState: "none" | "queued" | "delivered";
  readonly noticeVersion: number;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface HandoffRow extends Omit<BotHandoff, "projectId"> {
  readonly projectId: string;
}

const columns = `
  id, parent_id AS parentId, source_run_id AS sourceRunId,
  target_bot_id AS targetBotId, target_run_id AS targetRunId,
  project_id AS projectId, task_text AS taskText, context_text AS contextText,
  depth, status, response_text AS responseText, question_text AS questionText,
  last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
  , notification_state AS notificationState, notice_version AS noticeVersion, attempt
`;

const decode = (row: HandoffRow): BotHandoff => ({
  ...row,
  projectId: ProjectId.make(row.projectId),
});

export interface BotHandoffStoreShape {
  readonly insert: (handoff: BotHandoff) => Effect.Effect<void, PersistenceSqlError>;
  readonly get: (id: string) => Effect.Effect<BotHandoff | null, PersistenceSqlError>;
  readonly getForTargetRun: (
    runId: string,
  ) => Effect.Effect<BotHandoff | null, PersistenceSqlError>;
  readonly listBySourceRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listByProject: (
    projectId: ProjectId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listPending: () => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listUndelivered: () => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listUndeliveredByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listRunning: () => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listRunningByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly listAncestors: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<BotHandoff>, PersistenceSqlError>;
  readonly transition: (
    id: string,
    from: ReadonlyArray<BotHandoffStatus>,
    to: BotHandoffStatus,
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

export class BotHandoffStore extends Context.Service<BotHandoffStore, BotHandoffStoreShape>()(
  "t3/bots/BotHandoffStore",
) {}

export const BotHandoffStoreLive = Layer.effect(
  BotHandoffStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const error = toPersistenceSqlError("BotHandoffStore.query");
    const get = (id: string) =>
      sql<HandoffRow>`SELECT ${sql.unsafe(columns)} FROM bot_handoffs WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
        Effect.mapError(error),
      );
    return {
      insert: (handoff) =>
        sql`
          INSERT OR IGNORE INTO bot_handoffs (
            id, parent_id, source_run_id, target_bot_id, target_run_id, project_id,
            task_text, context_text, depth, status, response_text, question_text,
            last_error, notification_state, notice_version, attempt, created_at, updated_at
          ) VALUES (
            ${handoff.id}, ${handoff.parentId}, ${handoff.sourceRunId}, ${handoff.targetBotId},
            ${handoff.targetRunId}, ${handoff.projectId}, ${handoff.taskText},
            ${handoff.contextText}, ${handoff.depth}, ${handoff.status},
            ${handoff.responseText}, ${handoff.questionText}, ${handoff.lastError},
            ${handoff.notificationState}, ${handoff.noticeVersion}, ${handoff.attempt},
            ${handoff.createdAt}, ${handoff.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.mapError(error)),
      get,
      getForTargetRun: (runId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE target_run_id = ${runId}
        `.pipe(
          Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
          Effect.mapError(error),
        ),
      listBySourceRun: (runId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE source_run_id = ${runId} ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listByProject: (projectId, limit) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE project_id = ${projectId} AND (
            status IN ('queued', 'running', 'needs-input') OR id IN (
              SELECT id FROM bot_handoffs
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
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE status = 'queued' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listUndelivered: () =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE notification_state = 'queued' ORDER BY updated_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listUndeliveredByProject: (projectId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE project_id = ${projectId} AND notification_state = 'queued'
          ORDER BY updated_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listRunning: () =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE status = 'running' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listRunningByProject: (projectId) =>
        sql<HandoffRow>`
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE project_id = ${projectId} AND status = 'running' ORDER BY created_at, id
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      listAncestors: (id) =>
        sql<HandoffRow>`
          WITH RECURSIVE lineage(id, parent_id) AS (
            SELECT id, parent_id FROM bot_handoffs WHERE id = ${id}
            UNION ALL
            SELECT h.id, h.parent_id FROM bot_handoffs AS h
            JOIN lineage AS l ON h.id = l.parent_id
          )
          SELECT ${sql.unsafe(columns)} FROM bot_handoffs
          WHERE id IN (SELECT id FROM lineage)
        `.pipe(
          Effect.map((rows) => rows.map(decode)),
          Effect.mapError(error),
        ),
      transition: (id, from, to, at, fields, notify = false) =>
        sql<{ readonly id: string }>`
          UPDATE bot_handoffs SET
            status = ${to}, updated_at = ${at},
            response_text = ${fields?.responseText ?? null},
            question_text = ${fields?.questionText ?? null},
            last_error = ${fields?.lastError ?? null},
            notification_state = CASE WHEN ${notify ? 1 : 0} = 1 THEN 'queued' ELSE notification_state END,
            notice_version = notice_version + ${notify ? 1 : 0}
          WHERE id = ${id} AND ${sql.in("status", from)} RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(error),
        ),
      markDelivered: (id, version) =>
        sql`
          UPDATE bot_handoffs SET notification_state = 'delivered'
          WHERE id = ${id} AND notice_version = ${version} AND notification_state = 'queued'
        `.pipe(Effect.asVoid, Effect.mapError(error)),
      retry: (id, at) =>
        sql<{ readonly id: string }>`
          UPDATE bot_handoffs SET
            status = 'queued', attempt = attempt + 1,
            target_run_id = 'bot-handoff:' || id || ':attempt:' || (attempt + 1),
            response_text = NULL, question_text = NULL, last_error = NULL,
            notification_state = 'none', updated_at = ${at}
          WHERE id = ${id} AND status IN ('failed', 'cancelled') AND attempt < 10
          RETURNING id
        `.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.mapError(error),
        ),
      getRunByThread: (threadId) =>
        sql<{ readonly id: string }>`
          SELECT id FROM bot_runs WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => rows[0]?.id ?? null),
          Effect.mapError(error),
        ),
    } satisfies BotHandoffStoreShape;
  }),
);
