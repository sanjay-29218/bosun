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

/** Another issue an issue is structured with: its parent, or one of its sub-issues. */
export const IssueStructureRef = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  url: Schema.String,
});
export type IssueStructureRef = typeof IssueStructureRef.Type;

/** One issue with its description and comments, as its detail view reads it. */
export const RepositoryIssueDetail = Schema.Struct({
  ...RepositoryIssue.fields,
  /** Older servers omit it. */
  parentIssue: Schema.optionalKey(Schema.NullOr(IssueStructureRef)),
  /** Its sub-issues, up to 50; null when the host couldn't read them. Older servers omit it. */
  subIssueList: Schema.optionalKey(Schema.NullOr(Schema.Array(IssueStructureRef))),
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
  /** An open milestone's number. */
  milestone: Schema.optionalKey(Schema.Int),
  /** The issue it is a sub-issue of. */
  parent: Schema.optionalKey(Schema.Int),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

/**
 * Changes the title, body, milestone or parent, whichever is given; null clears a milestone or
 * parent. With `expectedUpdatedAt`, the change is refused with `IssueChangedError` when the
 * host's copy was updated since that time.
 */
export const IssueUpdateInput = Schema.Struct({
  projectId: ProjectId,
  number: Schema.Int,
  title: Schema.optionalKey(TrimmedNonEmptyString),
  /** Markdown. */
  body: Schema.optionalKey(Schema.String),
  /** A milestone's number. */
  milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  /** The issue to make it a sub-issue of. */
  parent: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  expectedUpdatedAt: Schema.optionalKey(Schema.String),
});
export type IssueUpdateInput = typeof IssueUpdateInput.Type;

/** GitHub takes up to 10 MB in an issue; a pasted screenshot is well under that. */
export const ISSUE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** An image pasted into an issue's description, stored on the project's host. */
export const IssueImageUploadInput = Schema.Struct({
  projectId: ProjectId,
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  /** A `data:image/...;base64,` URL. */
  dataUrl: Schema.String.check(
    Schema.isPattern(/^data:image\/[\w.+-]+;base64,/i),
    Schema.isMaxLength(Math.ceil((ISSUE_IMAGE_MAX_BYTES * 4) / 3) + 100),
  ),
});
export type IssueImageUploadInput = typeof IssueImageUploadInput.Type;

/** Where the image now lives, for the description's Markdown to link. */
export const IssueImageUpload = Schema.Struct({ url: Schema.String });
export type IssueImageUpload = typeof IssueImageUpload.Type;

/** The issue was edited on its host after the editor read it; saving would overwrite that. */
export class IssueChangedError extends Schema.TaggedError<IssueChangedError>()(
  "IssueChangedError",
  { number: Schema.Int, updatedAt: Schema.String },
) {
  override get message(): string {
    return `Issue #${this.number} changed on GitHub since you opened it.`;
  }
}

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
