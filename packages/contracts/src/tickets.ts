import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueClosedReason } from "./issues.ts";

/**
 * A todo kept in Bosun rather than on a repository host. Its board lane comes from its state
 * and the feature working on it, the same way an issue's does.
 */
export const Ticket = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  /** Counts up per project; shown as `T-<number>`. */
  number: Schema.Int,
  title: Schema.String,
  /** Markdown. */
  description: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  closedReason: Schema.NullOr(IssueClosedReason),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
});
export type Ticket = typeof Ticket.Type;

export const ticketRef = (ticket: { readonly number: number }) => `T-${ticket.number}`;

export const TicketListInput = Schema.Struct({ projectId: ProjectId });
export type TicketListInput = typeof TicketListInput.Type;

export const TicketGetInput = Schema.Struct({ projectId: ProjectId, ticketId: Schema.String });
export type TicketGetInput = typeof TicketGetInput.Type;

export const TicketCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.String,
});
export type TicketCreateInput = typeof TicketCreateInput.Type;

/** Changes only the fields given. Closing without a reason closes it as completed. */
export const TicketUpdateInput = Schema.Struct({
  ...TicketGetInput.fields,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
  closedReason: Schema.optionalKey(IssueClosedReason),
});
export type TicketUpdateInput = typeof TicketUpdateInput.Type;

export class TicketOperationError extends Schema.TaggedError<TicketOperationError>()(
  "TicketOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
