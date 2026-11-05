import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProjectId,
  projectHeadquartersThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as BosunMigrations from "../persistence/BosunMigrations.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { CrewService } from "./CrewService.ts";
import * as ProjectRequests from "./ProjectRequests.ts";

const projectId = ProjectId.make("project:web");
const managerThreadId = projectHeadquartersThreadId(projectId);
const hq = ThreadId.make("bot-run:bot-hq:bot-captain");
const other = ThreadId.make("thread:person");
const botHome = ProjectId.make("project:bot-home");

const managerRun = (id: string, status = "completed") =>
  ({ id: RunId.make(id), threadId: managerThreadId, status, ordinal: 1 }) as OrchestrationV2Run;
const requestMessage = (requestId: string) => ({
  id: `message:project-request:${projectId}:${requestId}`,
  role: "user",
  text: `Request ${requestId}`,
});

/**
 * The service over a migrated database. `turns` holds the messages each manager run took, and
 * `active` the manager's run in progress.
 */
const setup = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 79 });
  yield* BosunMigrations.reconcileLegacyHistory();
  yield* BosunMigrations.runMigrations(105);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const turns = new Map<string, ReadonlyArray<object>>();
  const active: { run: OrchestrationV2Run | null } = { run: null };
  const layer = ProjectRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({} as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.succeed({
              runs: active.run === null ? [] : [active.run],
              messages: (filter?.messageRunIds ?? []).flatMap((runId) => turns.get(runId) ?? []),
            } as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ title: "Web" } as never),
        }),
        Layer.mock(CrewService)({
          ensureProjectManager: () => Effect.succeed({ threadId: managerThreadId } as never),
          requireManagedProject: (id) =>
            id === botHome ? Effect.fail(new Error("No Project manager") as never) : Effect.void,
        }),
      ),
    ),
  );
  const requests = yield* ProjectRequests.ProjectRequests.pipe(Effect.provide(layer));
  const sent = Ref.get(dispatched).pipe(
    Effect.map((all) =>
      all.flatMap((command) =>
        command.type === "message.dispatch"
          ? [{ threadId: command.threadId, id: command.messageId, text: command.text }]
          : [],
      ),
    ),
  );
  const clear = Ref.set(dispatched, []);
  return { requests, sent, clear, turns, active };
});

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("sends a request once per key, numbering requests per project", () =>
  Effect.gen(function* () {
    const { requests, sent } = yield* setup;
    const send = (key: string, requester = hq) =>
      requests.send({ projectId, requesterThreadId: requester, key, message: "Add CSV export" });

    const first = yield* send("csv");
    assert.strictEqual(first.request.id, "R-1");
    assert.strictEqual(first.managerThreadId, managerThreadId);
    assert.isNotNull(first.request.deliveredAt);
    // A retry finds the same request and doesn't post it again.
    assert.strictEqual((yield* send("csv")).request.id, "R-1");
    assert.strictEqual((yield* send("csv", other)).request.id, "R-2");

    const posted = yield* sent;
    assert.deepStrictEqual(
      posted.map((message) => [message.threadId, message.id]),
      [
        [managerThreadId, `message:project-request:${projectId}:R-1`],
        [managerThreadId, `message:project-request:${projectId}:R-2`],
      ],
    );
    assert.include(posted[0]!.text, "Request R-1 from thread");
    assert.include(posted[0]!.text, "Add CSV export");

    // Scratch and bots' homes have no manager, so nothing is stored to retry on every start.
    yield* requests
      .send({ projectId: botHome, requesterThreadId: hq, key: "home", message: "Notes" })
      .pipe(Effect.flip);
    const sql = yield* SqlClient.SqlClient;
    const stored = yield* sql`SELECT 1 FROM project_requests WHERE project_id = ${botHome}`;
    assert.lengthOf(stored, 0);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("posts a stored request that never reached its manager when the server starts", () =>
  Effect.gen(function* () {
    const { requests, sent } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    // Stored, then the server stopped before the post.
    yield* sql`
      INSERT INTO project_requests (
        project_id, number, id, requester_thread_id, send_key, text, created_at
      ) VALUES (${projectId}, 1, 'R-1', ${hq}, 'csv', 'Add CSV export', '2026-11-05')
    `;

    yield* requests.deliverPending();
    yield* requests.deliverPending();

    assert.deepStrictEqual(
      (yield* sent).map((message) => message.id),
      [`message:project-request:${projectId}:R-1`],
    );
    assert.isNotNull((yield* requests.get(projectId, "R-1"))?.deliveredAt);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("lets only the project's manager reply, and closes the request when it is done", () =>
  Effect.gen(function* () {
    const { requests, sent, clear } = yield* setup;
    yield* requests.send({ projectId, requesterThreadId: hq, key: "csv", message: "Add export" });
    yield* clear;
    const reply = (from: ThreadId, done?: boolean) =>
      requests.reply({
        managerThreadId: from,
        requestId: "R-1",
        key: done ? "done" : "started",
        message: done ? "Merged in #12." : "Started feature F-3.",
        issue: "#12",
        done,
      });

    for (const stranger of [hq, other, projectHeadquartersThreadId("project:other")]) {
      assert.strictEqual((yield* Effect.flip(reply(stranger)))._tag, "ProjectRequestError");
    }
    assert.deepStrictEqual(yield* sent, []);

    const started = yield* reply(managerThreadId);
    assert.deepStrictEqual([started.status, started.issueRef], ["open", "#12"]);
    const done = yield* reply(managerThreadId, true);
    assert.strictEqual(done.status, "done");
    assert.isNotNull(done.closedAt);
    const replies = yield* sent;
    assert.deepStrictEqual(
      replies.map((message) => [message.threadId, message.id]),
      [
        [hq, `message:project-request:${projectId}:R-1:reply:started`],
        [hq, `message:project-request:${projectId}:R-1:reply:done`],
      ],
    );
    assert.include(replies[1]!.text, "Web's project manager on R-1 (done)");
  }).pipe(Effect.provide(sqlite)),
);

it.effect("lists a project's requests to its manager, and a sender's own to the sender", () =>
  Effect.gen(function* () {
    const { requests } = yield* setup;
    yield* requests.send({ projectId, requesterThreadId: hq, key: "a", message: "One" });
    yield* requests.send({ projectId, requesterThreadId: other, key: "b", message: "Two" });
    yield* requests.reply({
      managerThreadId,
      requestId: "R-2",
      key: "done",
      message: "Done.",
      done: true,
    });
    const ids = (callerThreadId: ThreadId, status?: "open" | "done") =>
      requests
        .list({ callerThreadId, status })
        .pipe(Effect.map((listed) => listed.map((request) => request.id)));

    assert.deepStrictEqual(yield* ids(managerThreadId), ["R-1", "R-2"]);
    assert.deepStrictEqual(yield* ids(managerThreadId, "open"), ["R-1"]);
    assert.deepStrictEqual(yield* ids(hq), ["R-1"]);
    assert.deepStrictEqual(yield* ids(other), ["R-2"]);
    assert.deepStrictEqual(yield* ids(ThreadId.make("thread:stranger")), []);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("answers for a manager's turn that ended without replying, once", () =>
  Effect.gen(function* () {
    const { requests, sent, clear, turns, active } = yield* setup;
    for (const [key, requester] of [
      ["one", hq],
      ["two", other],
      ["three", hq],
      ["four", hq],
    ] as const) {
      yield* requests.send({ projectId, requesterThreadId: requester, key, message: key });
    }
    yield* clear;
    turns.set("run-1", [
      requestMessage("R-1"),
      { id: "message:answer", role: "assistant", text: "Started feature F-3.", streaming: false },
    ]);
    turns.set("run-2", [
      requestMessage("R-2"),
      requestMessage("R-3"),
      { id: "message:reply", role: "assistant", text: "R-2 is a task now.", streaming: false },
    ]);
    turns.set("run-3", [requestMessage("R-4")]);

    // The manager replies to R-2 during its turn, so R-2 needs nothing more.
    active.run = managerRun("run-2", "running");
    yield* requests.reply({ managerThreadId, requestId: "R-2", key: "k", message: "On it." });
    active.run = managerRun("run-3", "running");
    yield* requests.reply({ managerThreadId, requestId: "R-4", key: "k", message: "On it." });
    yield* clear;

    // One request: its sender gets what the manager said last.
    yield* requests.handleRunEnded(managerRun("run-1"));
    // Several: the last message may answer another of them, so R-3 only hears it arrived.
    yield* requests.handleRunEnded(managerRun("run-2"));
    // One request it replied to: nothing more.
    yield* requests.handleRunEnded(managerRun("run-3"));
    // A turn still running isn't over yet.
    yield* requests.handleRunEnded(managerRun("run-1", "running"));

    const answered = yield* sent;
    assert.deepStrictEqual(
      answered.map((message) => [message.threadId, message.id]),
      [
        [hq, `message:project-request:${projectId}:R-1:fallback:run-1`],
        [hq, `message:project-request:${projectId}:R-3:fallback:run-2`],
      ],
    );
    assert.include(answered[0]!.text, "Started feature F-3.");
    assert.include(answered[1]!.text, "R-3 reached Web's project manager");
    assert.notInclude(answered[1]!.text, "R-2 is a task now.");

    // After a restart, catching up on the same turns sends nothing again.
    yield* clear;
    for (const run of ["run-1", "run-2", "run-3"]) yield* requests.handleRunEnded(managerRun(run));
    assert.deepStrictEqual(yield* sent, []);
  }).pipe(Effect.provide(sqlite)),
);

it.effect(
  "recovers an earlier unanswered turn's fallback at startup, behind a newer run, once",
  () =>
    Effect.gen(function* () {
      const { requests, sent, clear, turns, active } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* requests.send({ projectId, requesterThreadId: hq, key: "one", message: "one" });
      yield* clear;
      // The turn that took R-1 ended, then the server stopped before its fallback went out.
      yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${`project-hq:${projectId}`}, 'project-manager:web', ${projectId},
        ${managerThreadId}, 'Manage', 'Project manager', '', '[]', 1, '{}', 'full-access',
        '2026-11-05')
    `;
      const run = (id: string, ordinal: number, userMessageId: string) => sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES (${id}, ${managerThreadId}, ${ordinal}, 'codex', 'completed', '2026-11-05',
        '2026-11-05', ${JSON.stringify({ userMessageId })})
    `;
      yield* run("run-1", 1, `message:project-request:${projectId}:R-1`);
      turns.set("run-1", [
        requestMessage("R-1"),
        { id: "message:answer", role: "assistant", text: "Started feature F-3.", streaming: false },
      ]);
      // A newer turn, on something else, is now the latest.
      yield* run("run-2", 2, "message:other");
      active.run = managerRun("run-2");

      yield* requests.catchUp();
      const recovered = yield* sent;
      assert.deepStrictEqual(
        recovered.map((message) => [message.threadId, message.id]),
        [[hq, `message:project-request:${projectId}:R-1:fallback:run-1`]],
      );
      assert.include(recovered[0]!.text, "Started feature F-3.");

      // A second restart finds nothing left to send.
      yield* clear;
      yield* requests.catchUp();
      assert.deepStrictEqual(yield* sent, []);
    }).pipe(Effect.provide(sqlite)),
);

it.effect("recovers a later turn's fallback at startup when an earlier turn replied", () =>
  Effect.gen(function* () {
    const { requests, sent, clear, turns, active } = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* requests.send({ projectId, requesterThreadId: hq, key: "one", message: "one" });
    yield* clear;
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${`project-hq:${projectId}`}, 'project-manager:web', ${projectId},
        ${managerThreadId}, 'Manage', 'Project manager', '', '[]', 1, '{}', 'full-access',
        '2026-11-05')
    `;
    const prompt = JSON.stringify({ userMessageId: `message:project-request:${projectId}:R-1` });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES
        ('run-1', ${managerThreadId}, 1, 'codex', 'completed', '2026-11-05', '2026-11-05', ${prompt}),
        ('run-2', ${managerThreadId}, 2, 'codex', 'completed', '2026-11-05', '2026-11-05', ${prompt})
    `;
    // The first turn replied without closing R-1; the second ended silent before a restart.
    yield* sql`
      INSERT INTO project_request_turns (project_id, request_id, run_id, replied, fallback_sent)
      VALUES (${projectId}, 'R-1', 'run-1', 1, 0)
    `;
    turns.set("run-2", [
      requestMessage("R-1"),
      {
        id: "message:later",
        role: "assistant",
        text: "Opened the pull request.",
        streaming: false,
      },
    ]);
    active.run = managerRun("run-2");

    yield* requests.catchUp();
    const recovered = yield* sent;
    assert.deepStrictEqual(
      recovered.map((message) => [message.threadId, message.id]),
      [[hq, `message:project-request:${projectId}:R-1:fallback:run-2`]],
    );
    assert.include(recovered[0]!.text, "Opened the pull request.");

    yield* clear;
    yield* requests.catchUp();
    assert.deepStrictEqual(yield* sent, []);
  }).pipe(Effect.provide(sqlite)),
);
