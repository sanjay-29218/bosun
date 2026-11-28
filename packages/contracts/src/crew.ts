import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { BotAvatar } from "./bots.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor, ProjectRemoteManager } from "./project.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Crew mode: global Roles (planner, designer, builder, reviewer...) and the
 * crew members a project or feature instantiates from them. Runs are the durable work those
 * members do. "Bot" is reserved for the top-level bots that own projects.
 */

export const CREW_TURN_STATE = {
  MISSING: "missing",
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
  ERROR: "error",
} as const;
export type CrewTurnState = (typeof CREW_TURN_STATE)[keyof typeof CREW_TURN_STATE];

export const CREW_DISPATCH_STATE = {
  QUEUED: "queued",
  STARTED: "started",
} as const;
export type CrewDispatchState = (typeof CREW_DISPATCH_STATE)[keyof typeof CREW_DISPATCH_STATE];

/** A starter role; clients offer the starter roles while it is missing. */
export const PLANNER_ROLE_ID = "role:planner";

/** A crew member: a role instantiated for a project, a feature, or the whole environment. */
export const CrewMemberSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  featureId: Schema.NullOr(Schema.String),
  roleId: Schema.NullOr(Schema.String),
  name: Schema.String,
  enabled: Schema.Boolean,
});
export type CrewMemberSummary = typeof CrewMemberSummary.Type;

export const CrewProjectInput = Schema.Struct({ projectId: ProjectId });

export const LibraryItemKind = Schema.Literals(["role", "workflow"]);
export type LibraryItemKind = typeof LibraryItemKind.Type;

/**
 * Why an import can't follow its source right now. `notLinked` is a source this machine doesn't
 * link to (unlinked, or a copy from before imports, which came over the source's own link).
 */
export const LibraryImportProblem = Schema.Literals([
  "unreachable",
  "expired",
  "denied",
  "outdated",
  "removed",
  "notLinked",
]);
export type LibraryImportProblem = typeof LibraryImportProblem.Type;

/**
 * Where an imported workflow or role came from. It keeps the source's id, so one id has at most
 * one source. `localRevision` is this row's revision right after the import was applied, so any
 * save here since makes it edited.
 */
export const ImportedFrom = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The source's revision this copy was taken at; null when unknown (copies from before imports). */
  revision: Schema.NullOr(Schema.Int),
  localRevision: Schema.Int,
  /** A newer source revision the last sync saw. */
  available: Schema.NullOr(Schema.Int),
  /** An update the person chose to skip; a newer one shows again. */
  skipped: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  problem: Schema.NullOr(LibraryImportProblem),
});
export type ImportedFrom = typeof ImportedFrom.Type;

/** A machine that imported this workflow or role, as its last sync here reported it. */
export const LibraryImporter = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** This machine's revision that one holds; null when unknown. */
  revision: Schema.NullOr(Schema.Int),
  /** It changed its copy since it took it. */
  edited: Schema.Boolean,
  seenAt: Schema.String,
  /** An update saved here waits for its next sync. */
  pending: Schema.Boolean,
});
export type LibraryImporter = typeof LibraryImporter.Type;

/** Older servers send neither. */
const libraryImportFields = {
  importedFrom: Schema.NullOr(ImportedFrom).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  importers: Schema.Array(LibraryImporter).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
};

/** Whether an import changed here since it was taken, and whether its source has a newer one. */
export const libraryImportState = (item: {
  readonly revision: number;
  readonly importedFrom: ImportedFrom | null;
}) => {
  const source = item.importedFrom;
  if (source === null) return { edited: false, updateAvailable: false };
  const seen = Math.max(source.revision ?? -1, source.skipped ?? -1);
  return {
    edited: item.revision !== source.localRevision,
    updateAvailable:
      source.problem === null && source.available !== null && source.available > seen,
  };
};

/** A global role: who a crew member is. Editing it never rewrites existing members. */
export const RoleConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
  /** Used when `modelSelection` can't run here, before the Settings fallback model. */
  fallbackModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  enabled: Schema.Boolean,
  revision: Schema.Int,
  ...libraryImportFields,
});
export type RoleConfig = typeof RoleConfig.Type;
const roleFields = {
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
  /** Absent keeps the role's fallback model; null clears it. */
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
};
/**
 * A machine that imported it and takes this save on its next sync. `replacesEdits` is what the
 * person agreed to: without it, a copy edited there keeps its edits and shows Update available.
 */
export const LibraryPushTarget = Schema.Struct({
  environmentId: EnvironmentId,
  replacesEdits: Schema.Boolean,
});
export type LibraryPushTarget = typeof LibraryPushTarget.Type;
const alsoUpdateOn = Schema.optionalKey(Schema.Array(LibraryPushTarget));
export const RoleCreateInput = Schema.Struct({ ...roleFields });
export const RoleUpdateInput = Schema.Struct({
  ...roleFields,
  expectedRevision: Schema.Int,
  enabled: Schema.Boolean,
  alsoUpdateOn,
});
/** The workflow a feature follows when none is chosen. People can edit it but not delete it. */
export const FEATURE_DELIVERY_WORKFLOW_ID = "workflow:feature-delivery";
/**
 * A workflow sent by value with a bot's request from a linked environment: the workflow at its
 * revision there, and the roles it names. A feature started for that request runs on these
 * instead of the library where it runs, which never gains them.
 */
/** A role as it travels between machines. */
export const SnapshotRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  modelSelection: ModelSelection,
  /** Tried when `modelSelection` can't run where the feature runs; older peers send none. */
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Older peers require it. Every role runs with full access, so it is ignored. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type SnapshotRole = typeof SnapshotRole.Type;
export const WorkflowSnapshot = Schema.Struct({
  workflow: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    instructions: Schema.String,
    /**
     * Older peers require it, so every peer sends it. Edited text in the role it names leads too;
     * the built-in lead text doesn't.
     */
    leadRoleId: Schema.optionalKey(Schema.String),
    crewRoleIds: Schema.Array(Schema.String),
    revision: Schema.Int,
  }),
  roles: Schema.Array(SnapshotRole),
});
export type WorkflowSnapshot = typeof WorkflowSnapshot.Type;
/** The built-in workflow whose lead splits big work into child features. */
export const EPIC_WORKFLOW_ID = "workflow:epic";

/**
 * How a kind of work runs: plain instructions and the roles it can hand work to. A feature's own
 * thread leads it, and gets the instructions with the brief as its first message.
 */
export const WorkflowConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  crewRoleIds: Schema.Array(Schema.String),
  revision: Schema.Int,
  ...libraryImportFields,
});
export type WorkflowConfig = typeof WorkflowConfig.Type;
const workflowFields = {
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  crewRoleIds: Schema.Array(Schema.String),
};
export const WorkflowCreateInput = Schema.Struct({ ...workflowFields });
export const WorkflowUpdateInput = Schema.Struct({
  ...workflowFields,
  expectedRevision: Schema.Int,
  alsoUpdateOn,
});
export const WorkflowDeleteInput = Schema.Struct({ id: Schema.String });

/** What importing one of a linked machine's workflows or roles would do here. */
export const LibraryImportStatus = Schema.Literals(["new", "update", "current", "replaces"]);
export type LibraryImportStatus = typeof LibraryImportStatus.Type;

export const LibraryImportableItem = Schema.Struct({
  kind: LibraryItemKind,
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  /** A workflow's crew; empty for a role. */
  crewRoleIds: Schema.Array(Schema.String),
  status: LibraryImportStatus,
  /** For `replaces`: what is here now. */
  replaces: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      /** The machine the one here was imported from, if it was. */
      importedFrom: Schema.NullOr(Schema.String),
      /** A built-in nobody changed. */
      stock: Schema.Boolean,
    }),
  ),
});
export type LibraryImportableItem = typeof LibraryImportableItem.Type;

export const LibraryImportableInput = Schema.Struct({ sourceEnvironmentId: EnvironmentId });
export const LibraryImportable = Schema.Struct({
  source: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
  /** Why nothing could be listed; `items` is empty then. */
  problem: Schema.NullOr(LibraryImportProblem),
  items: Schema.Array(LibraryImportableItem),
});
export type LibraryImportable = typeof LibraryImportable.Type;

/**
 * Imports these from a linked machine, or takes their update when they came from it. A workflow
 * brings the roles it names that this machine lacks. Without `replace`, one that would replace
 * this machine's own (or another machine's) is skipped.
 */
export const LibraryImportInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  roleIds: Schema.Array(Schema.String),
  workflowIds: Schema.Array(Schema.String),
  replace: Schema.Boolean,
});
export const LibraryImportResult = Schema.Struct({
  imported: Schema.Array(
    Schema.Struct({ kind: LibraryItemKind, id: Schema.String, name: Schema.String }),
  ),
  skipped: Schema.Array(
    Schema.Struct({
      kind: LibraryItemKind,
      id: Schema.String,
      reason: Schema.Literals(["replaces", "missing", "current", "edited"]),
    }),
  ),
});
export type LibraryImportResult = typeof LibraryImportResult.Type;

/** `detach` keeps it as this machine's own; `skip` hides the update available now. */
export const LibraryDetachMode = Schema.Literals(["detach", "skip"]);
export const LibraryDetachInput = Schema.Struct({
  kind: LibraryItemKind,
  id: Schema.String,
  mode: LibraryDetachMode,
});

/** Creates the default roles and workflow that are missing, using `modelSelection` for each role. */
export const CrewInitializeInput = Schema.Struct({ modelSelection: ModelSelection });

export const CrewHierarchyNode = Schema.Struct({
  memberId: Schema.String,
  parentMemberId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const CrewDelegationGrant = Schema.Struct({
  sourceMemberId: Schema.String,
  targetMemberId: Schema.String,
});
export const CrewConfigurationSnapshot = Schema.Struct({
  hierarchy: Schema.Array(CrewHierarchyNode),
  delegationGrants: Schema.Array(CrewDelegationGrant),
});
export const CrewInstantiateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  roleId: Schema.String,
});
export const CrewSetHierarchyInput = Schema.Struct({
  projectId: ProjectId,
  memberId: Schema.String,
  parentMemberId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const CrewSetDelegationInput = Schema.Struct({
  projectId: ProjectId,
  sourceMemberId: Schema.String,
  targetMemberId: Schema.String,
  allowed: Schema.Boolean,
});

/** The bot look a person chose for a project's manager. */
export const ProjectManagerIcon = Schema.Struct({ avatar: BotAvatar, color: ProjectIconColor });
export type ProjectManagerIcon = typeof ProjectManagerIcon.Type;

/** A project's manager as it is now, or as the role would make it before its first use. */
export const ProjectManagerSettings = Schema.Struct({
  projectId: ProjectId,
  /** Off, its bot does the project's work itself and its thread is archived. */
  enabled: Schema.Boolean,
  instructions: Schema.String,
  /** Saved in the project, rather than its defaults. */
  customized: Schema.Boolean,
  /** The member's revision; 0 before the project has one. */
  revision: Schema.Int,
  /** Its standing thread, null until it is first opened. */
  threadId: Schema.NullOr(ThreadId),
  /** Null shows the look clients derive from the project id. */
  icon: Schema.NullOr(ProjectManagerIcon),
});
export type ProjectManagerSettings = typeof ProjectManagerSettings.Type;
export const ProjectManagerUpdateInput = Schema.Struct({
  projectId: ProjectId,
  instructions: Schema.String,
  expectedRevision: Schema.Int,
});
export type ProjectManagerUpdateInput = typeof ProjectManagerUpdateInput.Type;
export const ProjectManagerResetInput = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: Schema.Int,
});
export type ProjectManagerResetInput = typeof ProjectManagerResetInput.Type;
export const ProjectManagerEnabledInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type ProjectManagerEnabledInput = typeof ProjectManagerEnabledInput.Type;
export const ProjectManagerIconInput = Schema.Struct({
  projectId: ProjectId,
  icon: Schema.NullOr(ProjectManagerIcon),
});
export type ProjectManagerIconInput = typeof ProjectManagerIconInput.Type;

/**
 * Where a project's manager lives. `remoteManager` set moves it to another
 * environment's copy and retires this copy's manager; null brings it here. `retired` notes in the
 * manager's thread here which copy's manager was retired for it.
 */
export const ProjectManagerPlacementInput = Schema.Struct({
  projectId: ProjectId,
  remoteManager: Schema.optionalKey(Schema.NullOr(ProjectRemoteManager)),
  retired: Schema.optionalKey(
    Schema.Struct({ environmentLabel: Schema.String, threadId: ThreadId }),
  ),
});
export type ProjectManagerPlacementInput = typeof ProjectManagerPlacementInput.Type;
/** The manager thread a move archived here, if any. */
export const ProjectManagerPlacementResult = Schema.Struct({
  retiredThreadId: Schema.NullOr(ThreadId),
});
export type ProjectManagerPlacementResult = typeof ProjectManagerPlacementResult.Type;

/** A project's manager thread, made and opened on first use. */
export const ProjectManagerThread = Schema.Struct({ threadId: ThreadId });
/** Starts a standing thread (a bot's headquarters or a project's manager) over in a new session. */
export const CrewStartNewSessionInput = Schema.Struct({ threadId: ThreadId });

export class CrewOperationError extends Schema.TaggedError<CrewOperationError>()(
  "CrewOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
