import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";

/**
 * The issue a feature or delegated task works on, as it read when linked. A Bosun ticket has
 * `ticketId` and an empty `url`; a tracker outside the project's host, such as Linear, has `key`.
 * `featureIssueRef` names every kind.
 */
export const FeatureIssue = Schema.Struct({
  url: Schema.String,
  ticketId: Schema.optionalKey(Schema.String),
  /** The tracker's own identifier, such as `LIN-123`; its title and state are not read. */
  key: Schema.optionalKey(Schema.String),
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  milestone: Schema.NullOr(Schema.String),
  /** Its sub-issues, closed and in all; null when it has none. */
  subIssues: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
});
export type FeatureIssue = typeof FeatureIssue.Type;

/** `#12` for an issue, `T-12` for a ticket, the tracker's key such as `LIN-12` otherwise. */
export const featureIssueRef = (issue: Pick<FeatureIssue, "number" | "ticketId" | "key">) =>
  issue.key ?? (issue.ticketId === undefined ? `#${issue.number}` : `T-${issue.number}`);

/** The feature a thread works on: its lead's thread and the crew threads the lead delegates. */
export const ThreadFeatureTag = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  issue: Schema.optionalKey(FeatureIssue),
  /** The crew member a delegated thread runs as, such as "Planner"; absent on the lead. */
  member: Schema.optionalKey(Schema.String),
});
export type ThreadFeatureTag = typeof ThreadFeatureTag.Type;

/** The bot request a crew handoff thread works on: the first handoff of its chain. */
export const ThreadCrewRequestTag = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** The crew member this thread runs as, such as "Builder". */
  member: Schema.String,
});
export type ThreadCrewRequestTag = typeof ThreadCrewRequestTag.Type;

const FeatureFields = {
  id: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  brief: Schema.String,
};
/**
 * Where a feature's lead and crew work: one new worktree and branch for the whole feature, or
 * the project's own checkout.
 */
export const FeatureWorkspace = Schema.Literals(["worktree", "local"]);
export type FeatureWorkspace = typeof FeatureWorkspace.Type;

export const FeatureCreateInput = Schema.Struct({
  ...FeatureFields,
  /** Defaults to `worktree`; a project that isn't a Git repository always works locally. */
  workspace: Schema.optionalKey(FeatureWorkspace),
  /** The branch a new worktree starts from; defaults to the checkout's current branch. */
  baseBranch: Schema.optionalKey(Schema.String),
  /**
   * `title` is a stand-in taken from the brief: the server replaces it with a short generated
   * title, as it does for thread titles. A retry may then send the stand-in again.
   */
  autoTitle: Schema.optionalKey(Schema.Boolean),
  /** Sent with the brief as the opening message of the feature's lead. */
  briefAttachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
  briefContext: Schema.optionalKey(OrchestrationMessageContext),
  /** The workflow the feature follows; defaults to Feature delivery. */
  workflowId: Schema.optionalKey(Schema.String),
});
export const FeatureRecord = Schema.Struct({
  ...FeatureFields,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["open", "closed"]),
  /** F-<number> within the project. Older servers omit it. */
  number: Schema.optionalKey(Schema.Int),
  /** The crew member of each role the lead can delegate to. */
  crewAssignments: Schema.Record(Schema.String, Schema.String),
  issue: Schema.NullOr(FeatureIssue),
  briefAttachments: Schema.optionalKey(Schema.Array(ChatAttachment)),
  /** The workflow the feature follows. Older servers omit it. */
  workflowId: Schema.optionalKey(Schema.String),
  /** The feature whose lead started this one, which hears when it finishes. */
  parentFeatureId: Schema.optionalKey(Schema.String),
});
export const FeatureProjectInput = Schema.Struct({ projectId: ProjectId });
export const FeatureGetInput = Schema.Struct({
  projectId: ProjectId,
  featureId: Schema.String,
});
export const FeatureSetStatusInput = Schema.Struct({
  ...FeatureGetInput.fields,
  status: Schema.Literals(["open", "closed"]),
});
/** Links the issue at `url` to the feature, replacing any other; null unlinks it. */
export const FeatureSetIssueInput = Schema.Struct({
  ...FeatureGetInput.fields,
  /** An issue link, or a ticket's `T-<number>`; null unlinks. */
  url: Schema.NullOr(Schema.String),
});

export const FeatureStartInput = FeatureGetInput;
/** A started feature and its lead's thread, where the brief went. */
export const FeatureStartResult = Schema.Struct({
  feature: FeatureRecord,
  leadThreadId: ThreadId,
});
export type FeatureStartResult = typeof FeatureStartResult.Type;

/**
 * One card on the Features board. Its column follows its lead's and crew's threads, which the
 * client already holds; a feature not started yet has no lead thread.
 */
export const FeatureBoardCard = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  /** F-<number> within the project. Older servers omit it. */
  number: Schema.optionalKey(Schema.Int),
  issue: Schema.NullOr(FeatureIssue),
  status: Schema.Literals(["open", "closed"]),
  leadThreadId: Schema.NullOr(ThreadId),
  /** Its parent feature, under which the board shows it. */
  parentFeatureId: Schema.optionalKey(Schema.String),
  /**
   * How its lead last reported, and during which lead run: `finished` through
   * t3_feature_finish, or a note the server sent when a child went quiet. Reopening clears it.
   */
  report: Schema.optionalKey(
    Schema.Struct({
      outcome: Schema.Literals(["finished", "closed", "stopped", "failed", "interrupted"]),
      runId: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FeatureBoardCard = typeof FeatureBoardCard.Type;

export class FeatureOperationError extends Schema.TaggedError<FeatureOperationError>()(
  "FeatureOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
