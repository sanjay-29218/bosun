// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];
const ENDED_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

export interface Notice {
  readonly threadId: ThreadId;
  /** One delivery per thread and key. Alone, it is sent as `key` / `message:<key>`. */
  readonly key: string;
  /** A newer notice about the same subject, such as a feature, replaces an undelivered older one. */
  readonly subject?: string | undefined;
  readonly text: string;
  readonly notification?:
    | {
        readonly childThreadId: ThreadId;
        readonly outcome: "updated" | "failed";
        readonly summary: string;
      }
    | undefined;
  /** A runtime request the notice is about; it is dropped once that request is no longer pending. */
  readonly requestId?: string | undefined;
}

/**
 * Notices for a thread, such as a bot's headquarters, that wake it. While the thread is busy they
 * wait, and it then gets them as one message, without needs-you notices answered meanwhile.
 */
export class NoticeInbox extends Context.Service<
  NoticeInbox,
  {
    readonly post: (notice: Notice) => Effect.Effect<void, PersistenceSqlError>;
    /** Delivers what waits for `threadId`, unless it is busy. */
    readonly flush: (threadId: ThreadId) => Effect.Effect<void, PersistenceSqlError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/features/NoticeInbox") {}

interface NoticeRow {
  readonly key: string;
  readonly text: string;
  readonly summary: string | null;
  readonly outcome: "updated" | "failed" | null;
  readonly sourceThreadId: string | null;
  readonly digestId: string;
  readonly position: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const queryError = toPersistenceSqlError("NoticeInbox.query");
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const rowColumns = sql`key, text, summary, outcome, source_thread_id AS sourceThreadId,
    digest_id AS digestId, rowid AS position`;

  const digestMessage = (threadId: ThreadId, rows: ReadonlyArray<NoticeRow>) => {
    const notified = rows.filter((row) => row.summary !== null && row.outcome !== null);
    if (rows.length === 1) {
      const [row] = rows as [NoticeRow];
      const notification: OrchestrationV2Notification | undefined =
        row.summary !== null && row.outcome !== null
          ? {
              source: {
                kind: "subagent",
                ...(row.sourceThreadId === null
                  ? {}
                  : { childThreadId: ThreadId.make(row.sourceThreadId) }),
              },
              outcome: row.outcome,
              summary: row.summary,
            }
          : undefined;
      return {
        commandId: CommandId.make(row.key),
        messageId: MessageId.make(`message:${row.key}`),
        threadId,
        text: row.text,
        notification,
      };
    }
    const digestId = rows[0]!.digestId;
    return {
      commandId: CommandId.make(digestId),
      messageId: MessageId.make(`message:${digestId}`),
      threadId,
      text: [
        `${rows.length} updates arrived while you were busy:`,
        ...rows.map((row) => row.text),
      ].join("\n\n---\n\n"),
      notification:
        notified.length === 0
          ? undefined
          : ({
              source: { kind: "subagent" },
              outcome: notified.some((row) => row.outcome === "failed") ? "failed" : "updated",
              summary: `${rows.length} updates arrived`,
            } satisfies OrchestrationV2Notification),
    };
  };

  /**
   * Sends a claimed digest. A crash before it is marked delivered leaves it claimed, and sending
   * it again under the same ids is a no-op if the first send landed.
   */
  const deliver = Effect.fn("NoticeInbox.deliver")(function* (
    threadId: ThreadId,
    rows: ReadonlyArray<NoticeRow>,
  ) {
    if (rows.length === 0) return;
    const { notification, ...message } = digestMessage(
      threadId,
      rows.toSorted((left, right) => left.position - right.position),
    );
    const digestId = rows[0]!.digestId;
    const sent = yield* engine
      .dispatch({
        type: "message.dispatch",
        ...message,
        ...(notification === undefined ? {} : { notification }),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Delivering notices failed", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
    // A rejected command stays rejected under its id, so a failed digest is claimed afresh later.
    yield* (
      sent
        ? sql`
            UPDATE notice_inbox SET delivered_at = ${yield* now}
            WHERE thread_id = ${threadId} AND digest_id = ${digestId}
          `
        : sql`
            UPDATE notice_inbox SET digest_id = NULL
            WHERE thread_id = ${threadId} AND digest_id = ${digestId}
          `
    ).pipe(Effect.mapError(queryError));
  });

  const flushUnlocked = Effect.fn("NoticeInbox.flush")(function* (threadId: ThreadId) {
    const claimed = yield* sql<NoticeRow>`
      SELECT ${rowColumns} FROM notice_inbox
      WHERE thread_id = ${threadId} AND digest_id IS NOT NULL
        AND delivered_at IS NULL AND dropped_at IS NULL
    `.pipe(Effect.mapError(queryError));
    const byDigest = Map.groupBy(claimed, (row) => row.digestId);
    for (const rows of byDigest.values()) yield* deliver(threadId, rows);

    const busy = yield* sql`
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
      LIMIT 1
    `.pipe(Effect.mapError(queryError));
    if (busy.length > 0) return;
    const droppedAt = yield* now;
    // A deleted thread hears nothing, and a question answered meanwhile is no news.
    yield* sql`
      UPDATE notice_inbox SET dropped_at = ${droppedAt}
      WHERE thread_id = ${threadId} AND digest_id IS NULL
        AND delivered_at IS NULL AND dropped_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS t
            WHERE t.thread_id = notice_inbox.thread_id AND t.deleted_at IS NOT NULL)
          OR (request_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runtime_requests AS r
            WHERE r.runtime_request_id = notice_inbox.request_id AND r.status = 'pending'))
        )
    `.pipe(Effect.mapError(queryError));
    const digestId = `notice-digest:${NodeCrypto.randomUUID()}`;
    const rows = yield* sql<NoticeRow>`
      UPDATE notice_inbox SET digest_id = ${digestId}
      WHERE thread_id = ${threadId} AND digest_id IS NULL
        AND delivered_at IS NULL AND dropped_at IS NULL
      RETURNING ${rowColumns}
    `.pipe(Effect.mapError(queryError));
    yield* deliver(threadId, rows);
  });

  const flush: NoticeInbox["Service"]["flush"] = (threadId) =>
    lock.withPermits(1)(flushUnlocked(threadId));

  const post: NoticeInbox["Service"]["post"] = Effect.fn("NoticeInbox.post")(function* (notice) {
    const createdAt = yield* now;
    const inserted = yield* sql`
      INSERT OR IGNORE INTO notice_inbox (thread_id, key, subject, text, summary, outcome,
        source_thread_id, request_id, created_at)
      VALUES (${notice.threadId}, ${notice.key}, ${notice.subject ?? null}, ${notice.text},
        ${notice.notification?.summary ?? null}, ${notice.notification?.outcome ?? null},
        ${notice.notification?.childThreadId ?? null}, ${notice.requestId ?? null}, ${createdAt})
      RETURNING key
    `.pipe(Effect.mapError(queryError));
    if (inserted.length === 0) return;
    // A stage's end replaces what waits about its subject; a question doesn't hide a report.
    if (notice.subject !== undefined && notice.requestId === undefined) {
      yield* sql`
        UPDATE notice_inbox SET dropped_at = ${createdAt}
        WHERE thread_id = ${notice.threadId} AND subject = ${notice.subject}
          AND key <> ${notice.key} AND digest_id IS NULL
          AND delivered_at IS NULL AND dropped_at IS NULL
      `.pipe(Effect.mapError(queryError));
    }
    yield* flush(notice.threadId);
  });

  const flushWaiting = Effect.fn("NoticeInbox.flushWaiting")(
    function* () {
      const threads = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT DISTINCT thread_id AS threadId FROM notice_inbox
        WHERE delivered_at IS NULL AND dropped_at IS NULL
      `.pipe(Effect.mapError(queryError));
      for (const { threadId } of threads) yield* flush(threadId);
    },
    Effect.catchCause((cause) => Effect.logWarning("Delivering waiting notices failed", { cause })),
  );

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && ENDED_RUN_STATUSES.has(event.payload.status)
      ? sql`
          SELECT 1 FROM notice_inbox
          WHERE thread_id = ${event.threadId} AND delivered_at IS NULL AND dropped_at IS NULL
          LIMIT 1
        `.pipe(
          Effect.mapError(queryError),
          Effect.flatMap((rows) => (rows.length > 0 ? flush(event.threadId) : Effect.void)),
          Effect.catchCause((cause) =>
            Effect.logWarning("Delivering notices failed", { threadId: event.threadId, cause }),
          ),
        )
      : Effect.void;

  // Following events first, then sending what waits, leaves no run end between the two unseen.
  const start: NoticeInbox["Service"]["start"] = Effect.fn("NoticeInbox.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Notice inbox stream failed", { cause })),
      ),
    );
    yield* forkParked(flushWaiting());
  });

  return NoticeInbox.of({ post, flush, start });
});

export const layer = Layer.effect(NoticeInbox, make);
