// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  TicketOperationError,
  ticketRef,
  type ProjectId,
  type RepositoryIssue,
  type Ticket,
  type TicketCreateInput,
  type TicketUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { FeatureService } from "../features/FeatureService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { listTickets, readTicket, readTicketByNumber } from "./ticketRows.ts";

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 65_536;

export class TicketService extends Context.Service<
  TicketService,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Ticket>, TicketOperationError>;
    readonly get: (
      projectId: ProjectId,
      ticketId: string,
    ) => Effect.Effect<Ticket, TicketOperationError>;
    /** A ticket by its `T-<number>` number. */
    readonly getByNumber: (
      projectId: ProjectId,
      number: number,
    ) => Effect.Effect<Ticket, TicketOperationError>;
    readonly create: (input: TicketCreateInput) => Effect.Effect<Ticket, TicketOperationError>;
    readonly update: (input: TicketUpdateInput) => Effect.Effect<Ticket, TicketOperationError>;
    /** Deletes the ticket and unlinks it from the features working on it. */
    readonly remove: (
      projectId: ProjectId,
      ticketId: string,
    ) => Effect.Effect<void, TicketOperationError>;
    /**
     * Files the ticket as an issue on the project's host, links its features to the issue
     * instead, and deletes the ticket.
     */
    readonly moveToIssue: (
      projectId: ProjectId,
      ticketId: string,
    ) => Effect.Effect<RepositoryIssue, TicketOperationError>;
  }
>()("t3/tickets/TicketService") {}

const fail = (reason: string) => Effect.fail(new TicketOperationError({ reason }));

const validate = (fields: { readonly title?: string; readonly description?: string }) => {
  if (fields.title !== undefined && fields.title.trim().length === 0) {
    return fail("A ticket needs a title.");
  }
  if (fields.title !== undefined && fields.title.length > TITLE_MAX) {
    return fail(`Ticket titles are at most ${TITLE_MAX} characters.`);
  }
  if (fields.description !== undefined && fields.description.length > DESCRIPTION_MAX) {
    return fail("The description is too long.");
  }
  return Effect.void;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const features = yield* FeatureService;
  const issues = yield* IssueService.IssueService;

  const storageFailure = (operation: string) => (error: unknown) =>
    Effect.logWarning(`Ticket ${operation} failed`, { error }).pipe(
      Effect.andThen(fail("Tickets could not be read or saved.")),
    );
  const withSql = <A, E>(operation: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch(storageFailure(operation)),
    );

  const get = Effect.fn("TicketService.get")(function* (projectId: ProjectId, ticketId: string) {
    const ticket = yield* withSql("read", readTicket(projectId, ticketId));
    return ticket ?? (yield* fail("Ticket not found."));
  });

  const getByNumber = Effect.fn("TicketService.getByNumber")(function* (
    projectId: ProjectId,
    number: number,
  ) {
    const ticket = yield* withSql("read", readTicketByNumber(projectId, number));
    return ticket ?? (yield* fail(`Ticket ${ticketRef({ number })} not found.`));
  });

  /** Features linked to the ticket, by their stored issue's `ticketId`. */
  const linkedFeatureIds = (ticketId: string) =>
    withSql(
      "feature lookup",
      sql<{ readonly id: string }>`
        SELECT id FROM features WHERE json_extract(issue_json, '$.ticketId') = ${ticketId}
      `,
    ).pipe(Effect.map((rows) => rows.map((row) => row.id)));

  const relink = Effect.fn("TicketService.relink")(function* (
    projectId: ProjectId,
    ticketId: string,
    url: string | null,
  ) {
    for (const id of yield* linkedFeatureIds(ticketId)) {
      yield* features
        .setIssue({ id, projectId, url })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Relinking a ticket's feature failed", { featureId: id, error }),
          ),
        );
    }
  });

  const create: TicketService["Service"]["create"] = Effect.fn("TicketService.create")(
    function* (input) {
      yield* validate(input);
      const project = yield* projects
        .get(input.projectId)
        .pipe(Effect.catch(storageFailure("project read")));
      if (Option.isNone(project)) return yield* fail("Project not found.");
      const id = `ticket:${NodeCrypto.randomUUID()}`;
      const now = DateTime.formatIso(yield* DateTime.now);
      // The number is taken in the insert itself, so concurrent creates cannot share one.
      yield* withSql(
        "create",
        sql`
          INSERT INTO tickets (id, project_id, number, title, description, state, created_at, updated_at)
          SELECT ${id}, ${input.projectId}, COALESCE(MAX(number), 0) + 1, ${input.title.trim()},
            ${input.description}, 'open', ${now}, ${now}
          FROM tickets WHERE project_id = ${input.projectId}
        `,
      );
      return yield* get(input.projectId, id);
    },
  );

  const update: TicketService["Service"]["update"] = Effect.fn("TicketService.update")(
    function* (input) {
      yield* validate(input);
      const current = yield* get(input.projectId, input.ticketId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const state = input.state ?? current.state;
      const closing = state === "closed";
      const closedReason = closing
        ? (input.closedReason ?? current.closedReason ?? "completed")
        : null;
      const closedAt = closing ? (current.state === "closed" ? current.closedAt : now) : null;
      yield* withSql(
        "update",
        sql`
          UPDATE tickets SET
            title = ${input.title?.trim() ?? current.title},
            description = ${input.description ?? current.description},
            state = ${state},
            closed_reason = ${closedReason},
            closed_at = ${closedAt},
            updated_at = ${now}
          WHERE id = ${current.id}
        `,
      );
      return yield* get(input.projectId, input.ticketId);
    },
  );

  const remove = Effect.fn("TicketService.remove")(function* (
    projectId: ProjectId,
    ticketId: string,
  ) {
    const ticket = yield* get(projectId, ticketId);
    yield* relink(projectId, ticket.id, null);
    yield* withSql("delete", sql`DELETE FROM tickets WHERE id = ${ticket.id}`);
  });

  const moveToIssue = Effect.fn("TicketService.moveToIssue")(function* (
    projectId: ProjectId,
    ticketId: string,
  ) {
    const ticket = yield* get(projectId, ticketId);
    const issue = yield* issues
      .create({ projectId, title: ticket.title, body: ticket.description })
      .pipe(Effect.mapError((error) => new TicketOperationError({ reason: error.reason })));
    if (ticket.state === "closed") {
      yield* issues
        .setState({
          projectId,
          number: issue.number,
          state: "closed",
          reason: ticket.closedReason ?? "completed",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Closing a moved ticket's issue failed", { error }),
          ),
        );
    }
    yield* relink(projectId, ticket.id, issue.url);
    yield* withSql("delete", sql`DELETE FROM tickets WHERE id = ${ticket.id}`);
    return issue;
  });

  return TicketService.of({
    list: Effect.fn("TicketService.list")((projectId) => withSql("list", listTickets(projectId))),
    get,
    getByNumber,
    create,
    update,
    remove,
    moveToIssue,
  });
});

export const layer = Layer.effect(TicketService, make);
