import { assert, it } from "@effect/vitest";
import { type OrchestrationV2ServerCommand, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as BosunMigrations from "../persistence/BosunMigrations.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NoticeInbox from "./NoticeInbox.ts";

const hq = ThreadId.make("bot-run:bot-hq:bot-captain");
const lead = ThreadId.make("thread:lead");

const migrated = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 79 });
  yield* BosunMigrations.reconcileLegacyHistory();
  yield* BosunMigrations.runMigrations();
});

/** A service over the database; `failing` makes its dispatches fail, as a crash mid-send would. */
const setup = (failing = false) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const inbox = yield* NoticeInbox.NoticeInbox.pipe(
      Effect.provide(
        NoticeInbox.layer.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                failing
                  ? Effect.die("server stopped")
                  : Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({} as never)),
            }),
          ),
        ),
      ),
    );
    const sent = Ref.get(dispatched).pipe(
      Effect.map((all) =>
        all.flatMap((command) => (command.type === "message.dispatch" ? [command] : [])),
      ),
    );
    return { inbox, sent };
  });

/** The recipient's turn: running holds notices back, completed lets them through. */
const setTurn = (status: "running" | "completed") =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:hq:1', ${hq}, 1, 'codex', ${status}, '2026-11-05T00:00:00.000Z', '{}')
      ON CONFLICT (run_id) DO UPDATE SET status = excluded.status
    `,
  );

const setRequest = (status: "pending" | "resolved") =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request:plan', ${lead}, 'node', 'user_input', ${status},
        '2026-11-05T00:00:00.000Z', '{}')
      ON CONFLICT (runtime_request_id) DO UPDATE SET status = excluded.status
    `,
  );

const report = (feature: string, outcome: "updated" | "failed" = "updated") => ({
  threadId: hq,
  key: `feature-report:${feature}`,
  subject: `feature:${feature}`,
  text: `Feature "${feature}" [finished]: done`,
  notification: { childThreadId: lead, outcome, summary: `Feature "${feature}" finished` },
});

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("sends a notice to an idle thread at once, and a key once", () =>
  Effect.gen(function* () {
    yield* migrated;
    const { inbox, sent } = yield* setup();
    yield* inbox.post(report("csv"));
    yield* inbox.post(report("csv"));
    const messages = yield* sent;
    assert.deepStrictEqual(
      messages.map((message) => [message.threadId, message.text]),
      [[hq, 'Feature "csv" [finished]: done']],
    );
    assert.match(messages[0]!.commandId, /^notice-digest:/);
    assert.strictEqual(messages[0]!.messageId, `message:${messages[0]!.commandId}`);
    assert.deepStrictEqual(messages[0]!.notification, {
      source: { kind: "subagent", childThreadId: lead },
      outcome: "updated",
      summary: 'Feature "csv" finished',
    });
  }).pipe(Effect.provide(sqlite)),
);

it.effect("holds notices for a busy thread and sends them as one message when it is free", () =>
  Effect.gen(function* () {
    yield* migrated;
    const { inbox, sent } = yield* setup();
    yield* setTurn("running");
    yield* inbox.post(report("csv"));
    yield* inbox.post(report("pdf", "failed"));
    yield* inbox.post({ threadId: hq, key: "project-merge:web:12", text: "PR #12 merged" });
    yield* inbox.flush(hq);
    assert.deepStrictEqual(yield* sent, []);

    yield* setTurn("completed");
    yield* inbox.flush(hq);
    yield* inbox.flush(hq);
    const messages = yield* sent;
    assert.lengthOf(messages, 1);
    const [digest] = messages;
    assert.match(digest!.text, /^3 updates arrived while you were busy:/);
    assert.include(digest!.text, 'Feature "csv" [finished]');
    assert.include(digest!.text, 'Feature "pdf" [finished]');
    assert.include(digest!.text, "PR #12 merged");
    assert.isBelow(digest!.text.indexOf('"csv"'), digest!.text.indexOf('"pdf"'));
    assert.deepStrictEqual(digest!.notification, {
      source: { kind: "subagent" },
      outcome: "failed",
      summary: "3 updates arrived",
    });
  }).pipe(Effect.provide(sqlite)),
);

it.effect("drops a question answered before delivery and a report a newer one replaces", () =>
  Effect.gen(function* () {
    yield* migrated;
    const { inbox, sent } = yield* setup();
    yield* setTurn("running");
    yield* setRequest("pending");
    const asked = {
      threadId: hq,
      key: "feature-report:request:request:plan",
      subject: "feature:csv",
      requestId: "request:plan",
      text: 'Feature "csv" is waiting on the person',
    };
    yield* inbox.post(asked);
    yield* inbox.post({ ...report("pdf"), key: "feature-report:pdf:stopped" });
    yield* inbox.post(report("pdf"));
    yield* setRequest("resolved");
    yield* setTurn("completed");
    yield* inbox.flush(hq);
    const messages = yield* sent;
    assert.deepStrictEqual(
      messages.map((message) => message.text),
      ['Feature "pdf" [finished]: done'],
    );

    // A question still open when the thread is free is delivered.
    yield* setRequest("pending");
    yield* inbox.post({ ...asked, key: "feature-report:request:again" });
    assert.include((yield* sent).at(-1)!.text, "waiting on the person");
  }).pipe(Effect.provide(sqlite)),
);

it.effect("after a restart, marks a digest the orchestrator accepted as sent", () =>
  Effect.gen(function* () {
    yield* migrated;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* setup();
    yield* setTurn("running");
    yield* before.inbox.post(report("csv"));
    yield* before.inbox.post(report("pdf"));
    // Claimed and sent, then the server stopped before marking it sent.
    yield* sql`UPDATE notice_inbox SET digest_id = 'notice-digest:landed'`;
    yield* sql`
      INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id,
        command_type, accepted_at, result_sequence, status)
      VALUES ('notice-digest:landed', 'thread', ${hq}, 'message.dispatch',
        '2026-11-05T00:00:00.000Z', 1, 'accepted')
    `;
    yield* setTurn("completed");

    const restarted = yield* setup();
    yield* restarted.inbox.flush(hq);
    yield* restarted.inbox.post(report("csv"));
    assert.deepStrictEqual(yield* restarted.sent, []);
    const pending = yield* sql`SELECT 1 FROM notice_inbox WHERE delivered_at IS NULL`;
    assert.deepStrictEqual(pending, []);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("after a restart, drops a claimed question answered before it was sent", () =>
  Effect.gen(function* () {
    yield* migrated;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* setup();
    yield* setTurn("running");
    yield* setRequest("pending");
    yield* before.inbox.post({
      threadId: hq,
      key: "feature-report:request:request:plan",
      subject: "feature:csv",
      requestId: "request:plan",
      text: 'Feature "csv" is waiting on the person',
    });
    yield* before.inbox.post(report("pdf"));
    // Claimed, then the server stopped before sending; the person answered meanwhile.
    yield* sql`UPDATE notice_inbox SET digest_id = 'notice-digest:cut-short'`;
    yield* setRequest("resolved");
    yield* setTurn("completed");

    const restarted = yield* setup();
    yield* restarted.inbox.flush(hq);
    const [message, ...rest] = yield* restarted.sent;
    assert.deepStrictEqual(rest, []);
    assert.strictEqual(message!.text, 'Feature "pdf" [finished]: done');
    assert.notStrictEqual(message!.commandId, "notice-digest:cut-short");
  }).pipe(Effect.provide(sqlite)),
);

it.effect("tries a notice whose send failed again under fresh ids", () =>
  Effect.gen(function* () {
    yield* migrated;
    const failing = yield* setup(true);
    yield* failing.inbox.post(report("csv"));
    yield* failing.inbox.post({ ...report("pdf"), key: "feature-report:pdf" });
    const healthy = yield* setup();
    yield* healthy.inbox.flush(hq);
    const [digest, ...rest] = yield* healthy.sent;
    assert.deepStrictEqual(rest, []);
    assert.match(digest!.text, /^2 updates arrived/);
  }).pipe(Effect.provide(sqlite)),
);
