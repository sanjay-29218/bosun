import type { ProjectId, Ticket } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const columns = (sql: SqlClient.SqlClient) =>
  sql.literal(
    "id, project_id AS projectId, number, title, description, state, closed_reason AS closedReason, created_at AS createdAt, updated_at AS updatedAt, closed_at AS closedAt",
  );

/** A `T-<number>` reference, alone or with surrounding whitespace. */
export const ticketNumberFromRef = (ref: string): number | null => {
  const match = /^\s*T-([1-9]\d*)\s*$/iu.exec(ref);
  return match ? Number(match[1]) : null;
};

export const readTicketByNumber = Effect.fn("ticketRows.readByNumber")(function* (
  projectId: ProjectId,
  number: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Ticket>`
      SELECT ${columns(sql)} FROM tickets WHERE project_id = ${projectId} AND number = ${number}
    `;
  return row ?? null;
});

export const readTicket = Effect.fn("ticketRows.read")(function* (
  projectId: ProjectId,
  ticketId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Ticket>`
      SELECT ${columns(sql)} FROM tickets WHERE project_id = ${projectId} AND id = ${ticketId}
    `;
  return row ?? null;
});

export const listTickets = Effect.fn("ticketRows.list")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Ticket>`
      SELECT ${columns(sql)} FROM tickets WHERE project_id = ${projectId} ORDER BY number DESC
    `;
});
