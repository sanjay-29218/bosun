import type {
  RepositoryIssue,
  RepositoryIssueComment,
  RepositoryIssueDetail,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

/** Comments the detail view reads at once; the rest stay on GitHub. */
export const ISSUE_COMMENTS_PAGE = 50;

const RestUser = Schema.NullOr(Schema.Struct({ login: Schema.String, avatar_url: Schema.String }));

const RestIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(RestUser),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  comments: Schema.optional(Schema.Int),
  milestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ number: Schema.Int, title: Schema.String })),
  ),
  // Labels arrive as objects, or as bare names from some older Enterprise hosts.
  labels: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          name: Schema.String,
          color: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ]),
    ),
  ),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RestUser))),
  sub_issues_summary: Schema.optional(
    Schema.NullOr(Schema.Struct({ total: Schema.Int, completed: Schema.Int })),
  ),
});
type RestIssue = typeof RestIssue.Type;

const RestComment = Schema.Struct({
  user: Schema.optional(RestUser),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  html_url: Schema.String,
});

export const decodeRestIssue = decodeJsonResult(RestIssue);
export const decodeRestComments = decodeJsonResult(Schema.Array(RestComment));

const toUser = (user: typeof RestUser.Type | undefined) =>
  user ? { login: user.login, avatarUrl: user.avatar_url } : null;

export function restIssueToRepositoryIssue(issue: RestIssue): RepositoryIssue {
  const subIssues = issue.sub_issues_summary;
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    milestone: issue.milestone ?? null,
    // REST does not name the parent; the board reads it from the GraphQL list.
    parent: null,
    subIssues:
      subIssues && subIssues.total > 0
        ? { completed: subIssues.completed, total: subIssues.total }
        : null,
    labels: (issue.labels ?? []).map((label) =>
      typeof label === "string"
        ? { name: label, color: "8b949e" }
        : { name: label.name, color: label.color ?? "8b949e" },
    ),
    assignees: (issue.assignees ?? []).flatMap((assignee) => {
      const user = toUser(assignee);
      return user ? [user] : [];
    }),
  };
}

const CLOSED_REASONS = new Set(["completed", "not_planned", "duplicate"] as const);
const closedReason = (issue: RestIssue): RepositoryIssueDetail["closedReason"] => {
  if (issue.state !== "closed") return null;
  const reason = issue.state_reason;
  return reason && CLOSED_REASONS.has(reason as never)
    ? (reason as RepositoryIssueDetail["closedReason"])
    : "completed";
};

export function restIssueDetail(
  issue: RestIssue,
  comments: ReadonlyArray<typeof RestComment.Type>,
): RepositoryIssueDetail {
  return {
    ...restIssueToRepositoryIssue(issue),
    body: issue.body ?? "",
    closedReason: closedReason(issue),
    author: toUser(issue.user),
    createdAt: issue.created_at,
    commentCount: issue.comments ?? comments.length,
    comments: comments.map((comment): RepositoryIssueComment => ({
      author: toUser(comment.user),
      body: comment.body ?? "",
      createdAt: comment.created_at,
      url: comment.html_url,
    })),
  };
}
