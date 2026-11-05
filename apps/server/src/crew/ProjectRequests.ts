import {
  CommandId,
  headquartersProjectId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import { CrewService, type CrewServiceError } from "./CrewService.ts";

class ProjectRequestError extends Error {
  readonly _tag = "ProjectRequestError";
}

export interface ProjectRequest {
  readonly projectId: ProjectId;
  /** R-<number>, counted per project. */
  readonly id: string;
  readonly requesterThreadId: ThreadId;
  readonly text: string;
  readonly issueRef: string | null;
  readonly status: "open" | "done";
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

interface ProjectRequestRow extends Omit<ProjectRequest, "projectId" | "requesterThreadId"> {
  readonly projectId: string;
  readonly requesterThreadId: string;
  readonly sendKey: string;
}

export type ProjectRequestsError =
  | ProjectRequestError
  | PersistenceSqlError
  | OrchestratorV2Error
  | CrewServiceError;

export interface ProjectRequestsShape {
  /**
   * Stores a request for the project's manager and posts it to the manager's thread, made on
   * first use. The same requester and `key` find the same request, posted once.
   */
  readonly send: (input: {
    readonly projectId: ProjectId;
    readonly requesterThreadId: ThreadId;
    readonly key: string;
    readonly message: string;
  }) => Effect.Effect<
    { readonly request: ProjectRequest; readonly managerThreadId: ThreadId },
    ProjectRequestsError
  >;
  /** Answers a request of the manager's project to whoever sent it; `done` closes it. */
  readonly reply: (input: {
    readonly managerThreadId: ThreadId;
    readonly requestId: string;
    readonly key: string;
    readonly message: string;
    readonly issue?: string | undefined;
    readonly done?: boolean | undefined;
  }) => Effect.Effect<ProjectRequest, ProjectRequestsError>;
  /** The manager's thread sees its project's requests; any other thread the ones it sent. */
  readonly list: (input: {
    readonly callerThreadId: ThreadId;
    readonly status?: "open" | "done" | undefined;
  }) => Effect.Effect<ReadonlyArray<ProjectRequest>, PersistenceSqlError>;
  readonly get: (
    projectId: ProjectId,
    requestId: string,
  ) => Effect.Effect<ProjectRequest | null, PersistenceSqlError>;
  /** Posts each request that was stored but never reached its manager, as after a restart. */
  readonly deliverPending: () => Effect.Effect<void>;
  /** Replies for the manager when its turn took requests and ended without answering them. */
  readonly handleRunEnded: (run: OrchestrationV2Run) => Effect.Effect<void>;
  /** Checks each manager's latest turn, which may have ended while nothing was watching. */
  readonly catchUp: () => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProjectRequests extends Context.Service<ProjectRequests, ProjectRequestsShape>()(
  "t3/crew/ProjectRequests",
) {}

const ENDED_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const MAX_FORWARD_CHARS = 8_000;
const REQUEST_ID = /^R-[1-9]\d*$/u;

const requestIds = (projectId: ProjectId, requestId: string) => {
  const base = `project-request:${projectId}:${requestId}`;
  return {
    base,
    commandId: CommandId.make(base),
    messageId: MessageId.make(`message:${base}`),
  };
};

const decode = (row: ProjectRequestRow): ProjectRequest => ({
  projectId: ProjectId.make(row.projectId),
  id: row.id,
  requesterThreadId: ThreadId.make(row.requesterThreadId),
  text: row.text,
  issueRef: row.issueRef,
  status: row.status === "done" ? "done" : "open",
  deliveredAt: row.deliveredAt,
  createdAt: row.createdAt,
  closedAt: row.closedAt,
});

const text = (value: string, label: string, max: number) => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max
    ? Effect.fail(new ProjectRequestError(`Give ${label} (up to ${max} characters)`))
    : Effect.succeed(trimmed);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const crew = yield* CrewService;
  const queryError = toPersistenceSqlError("ProjectRequests.query");

  const columns = sql`
    project_id AS projectId, id, requester_thread_id AS requesterThreadId, send_key AS sendKey,
    text, issue_ref AS issueRef, status, delivered_at AS deliveredAt, created_at AS createdAt,
    closed_at AS closedAt
  `;
  const get: ProjectRequestsShape["get"] = (projectId, requestId) =>
    sql<ProjectRequestRow>`
      SELECT ${columns} FROM project_requests WHERE project_id = ${projectId} AND id = ${requestId}
    `.pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(queryError),
    );

  const projectName = (projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.map(Option.match({ onNone: () => projectId, onSome: (project) => project.title })),
      Effect.orElseSucceed(() => projectId),
    );

  /** Posts the request to its manager; the IDs come from the request, so a repeat is a no-op. */
  const deliver = Effect.fn("ProjectRequests.deliver")(function* (
    request: ProjectRequest,
    managerThreadId: ThreadId,
  ) {
    const ids = requestIds(request.projectId, request.id);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: ids.commandId,
      messageId: ids.messageId,
      threadId: managerThreadId,
      text: `Request ${request.id} from thread ${request.requesterThreadId}:\n\n${request.text}\n\nAnswer it with t3_project_reply, requestId "${request.id}".`,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    const deliveredAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE project_requests SET delivered_at = ${deliveredAt}
      WHERE project_id = ${request.projectId} AND id = ${request.id} AND delivered_at IS NULL
    `.pipe(Effect.mapError(queryError));
  });

  /** Tells the request's sender what the manager said, once per `key`. */
  const tellRequester = (
    request: ProjectRequest,
    managerThreadId: ThreadId,
    key: string,
    message: string,
    summary: string,
  ) => {
    const base = `${requestIds(request.projectId, request.id).base}:${key}`;
    return engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(base),
      messageId: MessageId.make(`message:${base}`),
      threadId: request.requesterThreadId,
      text: message,
      notification: {
        source: { kind: "subagent", childThreadId: managerThreadId },
        outcome: "updated",
        summary,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  };

  const markTurn = (
    projectId: ProjectId,
    requestId: string,
    runId: string,
    column: "replied" | "fallback_sent",
  ) =>
    sql`
      INSERT INTO project_request_turns (project_id, request_id, run_id, replied, fallback_sent)
      VALUES (${projectId}, ${requestId}, ${runId}, ${column === "replied" ? 1 : 0},
        ${column === "fallback_sent" ? 1 : 0})
      ON CONFLICT (project_id, request_id, run_id) DO UPDATE SET
        replied = MAX(replied, excluded.replied),
        fallback_sent = MAX(fallback_sent, excluded.fallback_sent)
    `.pipe(Effect.asVoid, Effect.mapError(queryError));

  const send: ProjectRequestsShape["send"] = Effect.fn("ProjectRequests.send")(function* (input) {
    const message = yield* text(input.message, "the request", 16_000);
    const key = yield* text(input.key, "a key", 200);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const row = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [existing] = yield* sql<ProjectRequestRow>`
            SELECT ${columns} FROM project_requests
            WHERE requester_thread_id = ${input.requesterThreadId} AND send_key = ${key}
          `;
          if (existing) return existing;
          const [next] = yield* sql<{ readonly number: number }>`
            SELECT COALESCE(MAX(number), 0) + 1 AS number FROM project_requests
            WHERE project_id = ${input.projectId}
          `;
          const number = next?.number ?? 1;
          const id = `R-${number}`;
          yield* sql`
            INSERT INTO project_requests (
              project_id, number, id, requester_thread_id, send_key, text, created_at
            ) VALUES (
              ${input.projectId}, ${number}, ${id}, ${input.requesterThreadId}, ${key},
              ${message}, ${createdAt}
            )
          `;
          return {
            projectId: input.projectId,
            id,
            requesterThreadId: input.requesterThreadId,
            sendKey: key,
            text: message,
            issueRef: null,
            status: "open" as const,
            deliveredAt: null,
            createdAt,
            closedAt: null,
          };
        }),
      )
      .pipe(Effect.mapError((error) => (SqlError.isSqlError(error) ? queryError(error) : error)));
    if (row.projectId !== input.projectId) {
      return yield* Effect.fail(
        new ProjectRequestError(`Key ${key} already sent ${row.id} to another project`),
      );
    }
    const request = decode(row);
    const run = yield* crew.ensureProjectManager(input.projectId);
    if (request.deliveredAt === null) yield* deliver(request, run.threadId);
    return {
      request: (yield* get(request.projectId, request.id)) ?? request,
      managerThreadId: run.threadId,
    };
  });

  /** The manager thread's turn in progress, which a reply answers for. */
  const activeRunOf = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["runs"], {
        runStatuses: ["preparing", "queued", "starting", "running", "waiting"],
      })
      .pipe(
        Effect.map(
          ({ runs }) =>
            runs
              .filter((run) => run.status === "running" || run.status === "waiting")
              .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null,
        ),
      );

  const reply: ProjectRequestsShape["reply"] = Effect.fn("ProjectRequests.reply")(
    function* (input) {
      const projectId = headquartersProjectId(input.managerThreadId);
      if (projectId === null) {
        return yield* Effect.fail(
          new ProjectRequestError("Only a project's manager thread answers its requests"),
        );
      }
      const request = yield* get(projectId, input.requestId);
      if (request === null) {
        return yield* Effect.fail(
          new ProjectRequestError(`This project has no request ${input.requestId}`),
        );
      }
      const message = yield* text(input.message, "a reply", 16_000);
      const key = yield* text(input.key, "a key", 200);
      const done = input.done === true;
      yield* tellRequester(
        request,
        input.managerThreadId,
        `reply:${key}`,
        `${yield* projectName(projectId)}'s project manager on ${request.id}${done ? " (done)" : ""}:\n\n${message}`,
        done ? `${request.id} is done` : `${request.id} has an update`,
      );
      const issue = input.issue?.trim();
      if (issue) {
        yield* sql`
          UPDATE project_requests SET issue_ref = ${issue}
          WHERE project_id = ${projectId} AND id = ${request.id}
        `.pipe(Effect.mapError(queryError));
      }
      const run = yield* activeRunOf(input.managerThreadId).pipe(Effect.orElseSucceed(() => null));
      if (run !== null) yield* markTurn(projectId, request.id, run.id, "replied");
      if (done) {
        const closedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE project_requests SET status = 'done', closed_at = COALESCE(closed_at, ${closedAt})
          WHERE project_id = ${projectId} AND id = ${request.id}
        `.pipe(Effect.mapError(queryError));
      }
      return (yield* get(projectId, request.id)) ?? request;
    },
  );

  const list: ProjectRequestsShape["list"] = (input) => {
    const projectId = headquartersProjectId(input.callerThreadId);
    const scope =
      projectId === null
        ? sql`requester_thread_id = ${input.callerThreadId}`
        : sql`project_id = ${projectId}`;
    const status = input.status === undefined ? sql`` : sql`AND status = ${input.status}`;
    return sql<ProjectRequestRow>`
      SELECT ${columns} FROM project_requests WHERE ${scope} ${status}
      ORDER BY created_at, project_id, number
    `.pipe(
      Effect.map((rows) => rows.map(decode)),
      Effect.mapError(queryError),
    );
  };

  const deliverPending: ProjectRequestsShape["deliverPending"] = Effect.fn(
    "ProjectRequests.deliverPending",
  )(
    function* () {
      const pending = yield* sql<ProjectRequestRow>`
        SELECT ${columns} FROM project_requests WHERE delivered_at IS NULL AND status = 'open'
        ORDER BY created_at, number
      `.pipe(Effect.mapError(queryError));
      for (const row of pending) {
        const request = decode(row);
        yield* crew.ensureProjectManager(request.projectId).pipe(
          Effect.flatMap((run) => deliver(request, run.threadId)),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not deliver a project request", {
              requestId: request.id,
              projectId: request.projectId,
              cause,
            }),
          ),
        );
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Delivering project requests failed", { cause }),
    ),
  );

  const handleRunEnded: ProjectRequestsShape["handleRunEnded"] = Effect.fn(
    "ProjectRequests.handleRunEnded",
  )(
    function* (run) {
      if (!ENDED_RUN_STATUSES.has(run.status)) return;
      const projectId = headquartersProjectId(run.threadId);
      if (projectId === null) return;
      const { messages } = yield* projections.getThreadRecords(run.threadId, ["messages"], {
        messageRunIds: [run.id],
      });
      const prefix = `message:project-request:${projectId}:`;
      const taken = [
        ...new Set(
          messages.flatMap((message) => {
            if (message.role !== "user" || !message.id.startsWith(prefix)) return [];
            const id = message.id.slice(prefix.length);
            return REQUEST_ID.test(id) ? [id] : [];
          }),
        ),
      ];
      if (taken.length === 0) return;
      const turns = yield* sql<{
        readonly requestId: string;
        readonly replied: number;
        readonly fallbackSent: number;
      }>`
        SELECT request_id AS requestId, replied, fallback_sent AS fallbackSent
        FROM project_request_turns WHERE project_id = ${projectId} AND run_id = ${run.id}
      `.pipe(Effect.mapError(queryError));
      const handled = new Set(
        turns
          .filter((turn) => turn.replied === 1 || turn.fallbackSent === 1)
          .map((turn) => turn.requestId),
      );
      const unanswered: Array<ProjectRequest> = [];
      for (const id of taken) {
        if (handled.has(id)) continue;
        const request = yield* get(projectId, id);
        if (request !== null && request.status === "open") unanswered.push(request);
      }
      if (unanswered.length === 0) return;
      const name = yield* projectName(projectId);
      const said =
        messages
          .findLast((message) => message.role === "assistant" && !message.streaming)
          ?.text.trim() ?? "";
      const forwarded =
        said.length > MAX_FORWARD_CHARS
          ? `${said.slice(0, MAX_FORWARD_CHARS)}… (read the rest in its thread)`
          : said || "(no message)";
      for (const request of unanswered) {
        // With one request the turn's last message answers it; with several, nothing says which.
        const message =
          unanswered.length === 1
            ? `${name}'s project manager ended its turn on ${request.id} without replying. Its last message:\n\n${forwarded}`
            : `${request.id} reached ${name}'s project manager, which is on it.`;
        yield* tellRequester(
          request,
          run.threadId,
          `fallback:${run.id}`,
          message,
          `${request.id} has an update`,
        );
        yield* markTurn(projectId, request.id, run.id, "fallback_sent");
      }
    },
    (effect, run) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Answering a project manager's turn failed", {
            threadId: run.threadId,
            cause,
          }),
        ),
      ),
  );

  const catchUp: ProjectRequestsShape["catchUp"] = Effect.fn("ProjectRequests.catchUp")(
    function* () {
      const managers = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS threadId FROM crew_runs WHERE id LIKE 'project-hq:%'
      `.pipe(Effect.mapError(queryError));
      for (const { threadId } of managers) {
        const { runs } = yield* projections.getThreadRecords(ThreadId.make(threadId), ["runs"], {
          runStatuses: [],
          includeLatestRun: true,
        });
        for (const run of runs) yield* handleRunEnded(run);
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Catching up project requests failed", { cause }),
    ),
  );

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && headquartersProjectId(event.threadId) !== null
      ? handleRunEnded(event.payload)
      : Effect.void;

  const start: ProjectRequestsShape["start"] = Effect.fn("ProjectRequests.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Project request event stream failed", { cause }),
        ),
      ),
    );
    yield* forkParked(deliverPending().pipe(Effect.andThen(catchUp())));
  });

  return ProjectRequests.of({
    send,
    reply,
    list,
    get,
    deliverPending,
    handleRunEnded,
    catchUp,
    start,
  });
});

export const layer = Layer.effect(ProjectRequests, make);
