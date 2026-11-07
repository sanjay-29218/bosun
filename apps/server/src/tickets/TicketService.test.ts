// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type RepositoryIssue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { FeatureService } from "../features/FeatureService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TicketService from "./TicketService.ts";

const web = ProjectId.make("project:web");
const api = ProjectId.make("project:api");

const filed: RepositoryIssue = {
  number: 41,
  title: "Sketch the board",
  url: "https://github.com/acme/web/issues/41",
  state: "open",
  updatedAt: "2026-10-28T00:00:00Z",
  closedAt: null,
  milestone: null,
  parent: null,
  subIssues: null,
  labels: [],
  assignees: [],
};

interface Calls {
  readonly created: Array<{ readonly title: string; readonly body: string }>;
  readonly states: Array<{ readonly number: number; readonly state: string }>;
  readonly links: Array<{ readonly id: string; readonly url: string | null }>;
  readonly uploads: Array<{ readonly fileName: string; readonly dataUrl: string }>;
}

/** The service over a fresh database, with the host and features recording what they were asked. */
const withTickets = <A, E>(
  exercise: (
    calls: Calls,
  ) => Effect.Effect<
    A,
    E,
    | TicketService.TicketService
    | SqlClient.SqlClient
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tickets-")),
    );
    const calls: Calls = { created: [], states: [], links: [], uploads: [] };
    const layer = TicketService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite")).pipe(
            Layer.provide(NodeServices.layer),
          ),
          ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) =>
              Effect.succeed(
                id === web || id === api
                  ? Option.some({ workspaceRoot: "/repo" } as ProjectStore.ProjectRow)
                  : Option.none(),
              ),
          }),
          Layer.mock(IssueService.IssueService)({
            create: (input) =>
              Effect.sync(() => {
                calls.created.push({ title: input.title, body: input.body });
                return filed;
              }),
            uploadImage: (input) =>
              Effect.sync(() => {
                calls.uploads.push({ fileName: input.fileName, dataUrl: input.dataUrl });
                return { url: `https://github.com/acme/web/raw/sha/${input.fileName}` };
              }),
            setState: (input) =>
              Effect.sync(() => {
                calls.states.push({ number: input.number, state: input.state });
                return { ...filed, state: input.state };
              }),
          }),
          Layer.mock(FeatureService)({
            setIssue: (input) =>
              Effect.sync(() => {
                calls.links.push({ id: input.id, url: input.url });
                return {} as never;
              }),
          }),
        ),
      ),
    );
    return yield* exercise(calls).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

it.effect("numbers tickets per project from one", () =>
  withTickets(() =>
    Effect.gen(function* () {
      const tickets = yield* TicketService.TicketService;
      const first = yield* tickets.create({ projectId: web, title: " Board ", description: "" });
      const second = yield* tickets.create({ projectId: web, title: "Card", description: "" });
      const other = yield* tickets.create({ projectId: api, title: "Auth", description: "" });
      assert.deepStrictEqual(
        [first.number, second.number, other.number, first.title],
        [1, 2, 1, "Board"],
      );
      assert.deepStrictEqual(
        (yield* tickets.list(web)).map((ticket) => ticket.number),
        [2, 1],
      );
      const missing = yield* Effect.flip(
        tickets.create({ projectId: ProjectId.make("project:gone"), title: "X", description: "" }),
      );
      assert.strictEqual(missing.reason, "Project not found.");
    }),
  ),
);

it.effect("closes as completed by default, and reopening clears the close", () =>
  withTickets(() =>
    Effect.gen(function* () {
      const tickets = yield* TicketService.TicketService;
      const ticket = yield* tickets.create({ projectId: web, title: "Board", description: "" });
      const closed = yield* tickets.update({
        projectId: web,
        ticketId: ticket.id,
        state: "closed",
      });
      assert.strictEqual(closed.closedReason, "completed");
      assert.isNotNull(closed.closedAt);

      const notPlanned = yield* tickets.update({
        projectId: web,
        ticketId: ticket.id,
        closedReason: "not_planned",
      });
      // A reason alone changes the reason of a closed ticket, not when it closed.
      assert.deepStrictEqual(
        [notPlanned.state, notPlanned.closedReason, notPlanned.closedAt],
        ["closed", "not_planned", closed.closedAt],
      );

      const reopened = yield* tickets.update({
        projectId: web,
        ticketId: ticket.id,
        state: "open",
      });
      assert.deepStrictEqual(
        [reopened.state, reopened.closedReason, reopened.closedAt],
        ["open", null, null],
      );

      const otherProject = yield* Effect.flip(tickets.get(api, ticket.id));
      assert.strictEqual(otherProject.reason, "Ticket not found.");
    }),
  ),
);

it.effect("moves a closed ticket to a closed issue and relinks its features", () =>
  withTickets((calls) =>
    Effect.gen(function* () {
      const tickets = yield* TicketService.TicketService;
      const sql = yield* SqlClient.SqlClient;
      const ticket = yield* tickets.create({
        projectId: web,
        title: "Sketch the board",
        description: "- [ ] lanes",
      });
      yield* tickets.update({ projectId: web, ticketId: ticket.id, state: "closed" });
      const issueJson = JSON.stringify({ ticketId: ticket.id });
      yield* sql`
        INSERT INTO features (id, project_id, title, brief, created_at, issue_json)
        VALUES ('feature:linked', ${web}, 'Board', 'Sketch', '2026-10-28', ${issueJson}),
          ('feature:other', ${web}, 'Other', 'Other', '2026-10-28', NULL)
      `;

      const issue = yield* tickets.moveToIssue(web, ticket.id);
      assert.strictEqual(issue.url, filed.url);
      assert.deepStrictEqual(calls.created, [{ title: "Sketch the board", body: "- [ ] lanes" }]);
      assert.deepStrictEqual(calls.states, [{ number: 41, state: "closed" }]);
      assert.deepStrictEqual(calls.links, [{ id: "feature:linked", url: filed.url }]);
      assert.deepStrictEqual(yield* tickets.list(web), []);
    }),
  ),
);

it.effect("moves a ticket's pasted images to GitHub with it, and stays when one is missing", () =>
  withTickets((calls) =>
    Effect.gen(function* () {
      const tickets = yield* TicketService.TicketService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const id = "ticket-0b6f2a5e-8d1c-4f3a-9e2b-7c4d1a6e5f30";
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(
        NodePath.join(config.attachmentsDir, `${id}.png`),
        new Uint8Array([0x89, 0x50]),
      );
      const ticket = yield* tickets.create({
        projectId: web,
        title: "Board",
        description: `Before\n![shot](attachment:${id})\nAgain ![shot](attachment:${id})`,
      });
      yield* tickets.moveToIssue(web, ticket.id);
      const url = `https://github.com/acme/web/raw/sha/${id}.png`;
      assert.deepStrictEqual(calls.uploads, [
        { fileName: `${id}.png`, dataUrl: "data:image/png;base64,iVA=" },
      ]);
      assert.deepStrictEqual(calls.created, [
        { title: "Board", body: `Before\n![shot](${url})\nAgain ![shot](${url})` },
      ]);

      const gone = "ticket-1c7e3b6f-9e2d-4a4b-8f3c-8d5e2b7f6a41";
      const broken = yield* tickets.create({
        projectId: web,
        title: "Lanes",
        description: `![shot](attachment:${gone})`,
      });
      const failure = yield* Effect.flip(tickets.moveToIssue(web, broken.id));
      assert.strictEqual(
        failure.reason,
        `The ticket's image ${gone} couldn't be read, so the ticket stays.`,
      );
      assert.deepStrictEqual(
        (yield* tickets.list(web)).map((ticket) => ticket.title),
        ["Lanes"],
      );
      assert.strictEqual(calls.created.length, 1);
    }),
  ),
);

it.effect("unlinks a deleted ticket's features", () =>
  withTickets((calls) =>
    Effect.gen(function* () {
      const tickets = yield* TicketService.TicketService;
      const sql = yield* SqlClient.SqlClient;
      const ticket = yield* tickets.create({ projectId: web, title: "Board", description: "" });
      const issueJson = JSON.stringify({ ticketId: ticket.id });
      yield* sql`
        INSERT INTO features (id, project_id, title, brief, created_at, issue_json)
        VALUES ('feature:linked', ${web}, 'Board', 'Sketch', '2026-10-28', ${issueJson})
      `;
      yield* tickets.remove(web, ticket.id);
      assert.deepStrictEqual(calls.links, [{ id: "feature:linked", url: null }]);
      assert.deepStrictEqual(yield* tickets.list(web), []);
    }),
  ),
);
