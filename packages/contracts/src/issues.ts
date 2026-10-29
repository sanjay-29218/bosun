import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** One issue in a project's repository, as the board's Issues view lists it. */
export const RepositoryIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  milestone: Schema.NullOr(Schema.Struct({ number: Schema.Int, title: Schema.String })),
  /** The issue this one is a sub-issue of, when it is one. */
  parent: Schema.NullOr(Schema.Int),
  /** Its sub-issues, closed and in all; null when it has none. */
  subIssues: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
  /** `color` is the host's hex without the `#`. */
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  assignees: Schema.Array(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
});
export type RepositoryIssue = typeof RepositoryIssue.Type;

/** An open milestone, with progress counted over all of its issues. */
export const RepositoryMilestone = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  dueOn: Schema.NullOr(Schema.String),
  openIssues: Schema.Int,
  closedIssues: Schema.Int,
});
export type RepositoryMilestone = typeof RepositoryMilestone.Type;

export const IssueListInput = Schema.Struct({ projectId: ProjectId });
export type IssueListInput = typeof IssueListInput.Type;

/**
 * A project's open issues, its recently closed ones, and its open milestones. `unavailable`
 * says why there is nothing to read, such as a project whose remote is not on GitHub.
 */
export const IssueList = Schema.Struct({
  /** `owner/name` the issues were read from. */
  repository: Schema.NullOr(Schema.String),
  unavailable: Schema.NullOr(Schema.String),
  issues: Schema.Array(RepositoryIssue),
  milestones: Schema.Array(RepositoryMilestone),
  /** More open issues exist than were read. */
  truncated: Schema.Boolean,
  /** When the host was asked; reads are shared for a short while. */
  readAt: Schema.String,
});
export type IssueList = typeof IssueList.Type;

/** One comment on an issue, oldest first. */
export const RepositoryIssueComment = Schema.Struct({
  author: Schema.NullOr(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
  /** Markdown, as written on the host. */
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
});
export type RepositoryIssueComment = typeof RepositoryIssueComment.Type;

/** One issue with its description and comments, as its detail view reads it. */
export const RepositoryIssueDetail = Schema.Struct({
  ...RepositoryIssue.fields,
  /** Markdown, as written on the host. */
  body: Schema.String,
  /** Why a closed issue was closed. */
  closedReason: Schema.NullOr(Schema.Literals(["completed", "not_planned", "duplicate"])),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
  createdAt: Schema.String,
  commentCount: Schema.Int,
  /** The first comments, up to a page; `commentCount` says when there are more. */
  comments: Schema.Array(RepositoryIssueComment),
});
export type RepositoryIssueDetail = typeof RepositoryIssueDetail.Type;

export const IssueDetail = Schema.Struct({
  ...RepositoryIssueDetail.fields,
  /** When the host was asked. */
  readAt: Schema.String,
});
export type IssueDetail = typeof IssueDetail.Type;

export const IssueGetInput = Schema.Struct({ projectId: ProjectId, number: Schema.Int });
export type IssueGetInput = typeof IssueGetInput.Type;

export const IssueCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** Markdown. */
  body: Schema.String,
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

export const IssueClosedReason = Schema.Literals(["completed", "not_planned"]);
export type IssueClosedReason = typeof IssueClosedReason.Type;

export const IssueSetStateInput = Schema.Struct({
  projectId: ProjectId,
  number: Schema.Int,
  state: Schema.Literals(["open", "closed"]),
  /** For a close; completed when absent. */
  reason: Schema.optionalKey(IssueClosedReason),
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
