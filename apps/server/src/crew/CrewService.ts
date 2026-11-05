import {
  botHeadquartersRunId,
  botHeadquartersThreadId,
  type BotLongConversation,
  CREW_DISPATCH_STATE,
  CREW_TOOL_GRANTS,
  CREW_TURN_STATE,
  headquartersBotId,
  headquartersProjectId,
  isStandingThread,
  EPIC_WORKFLOW_ID,
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  projectHeadquartersRunId,
  projectHeadquartersThreadId,
  type ProjectManagerResetInput,
  type ProjectManagerSettings,
  type ProjectManagerUpdateInput,
  ThreadId,
  type CrewTurnState,
  type ModelSelection,
  type RunId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { OrchestratorV2Error as OrchestrationDispatchError } from "../orchestration-v2/Orchestrator.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  CrewStore,
  type CrewMember,
  type CrewDelegationGrant,
  type CrewHierarchyNode,
  type Role,
  type Workflow,
  type CrewRun,
  type CrewWorkspace,
} from "./CrewStore.ts";
import * as BotStore from "../bots/BotStore.ts";
import {
  FRESH_START_QUIET_MINUTES,
  freshStartBriefing,
  freshStartDue,
  headquartersIdle,
  type FreshStartRecords,
} from "./headquartersFreshStart.ts";
import { crewChangeNotifier } from "./CrewChanges.ts";
import { CrewThreadRuntime, type OpeningMessage } from "./CrewThreadRuntime.ts";
import {
  EPIC_INSTRUCTIONS,
  FEATURE_DELIVERY_INSTRUCTIONS,
  FEATURE_MANAGER_INSTRUCTIONS,
  PROJECT_MANAGER_INSTRUCTIONS,
  crewRunPrompt,
} from "./crewPrompts.ts";

class CrewValidationError extends Error {
  readonly _tag = "CrewValidationError";
}

/*
 * Member IDs below predate the Roles rename. They stay as they are because stored runs,
 * handoffs, grants and feature bindings reference them.
 */
/**
 * The member made from the Feature manager role for one project, created on first use. Its ID
 * predates the rename: every feature lead's run and thread ID is hashed from it.
 */
export const featureManagerMemberId = (projectId: ProjectId) => `bot-manager:${projectId}`;
/** The builder a feature manager hands direct requests to, created with the manager. */
export const projectBuilderMemberId = (projectId: ProjectId) => `bot-builder:${projectId}`;
/** A project's standing manager, made from the Project manager role on first use. */
const projectManagerMemberId = (projectId: ProjectId) => `project-manager:${projectId}`;
/** The member that leads a workflow led by a role other than the Feature manager. */
const projectLeadMemberId = (projectId: ProjectId, roleId: string) =>
  `bot-lead:${projectId}:${roleId}`;

/**
 * What a project-level member adds to its role's instructions, or null for a member that isn't
 * one of the project's own (an instantiated or feature member), which role edits don't reach.
 */
const projectMemberContext = (id: string, projectId: ProjectId | null) => {
  if (projectId === null) return null;
  if (id === featureManagerMemberId(projectId)) {
    return `You manage project ${projectId}. Its builder is crew member ${projectBuilderMemberId(projectId)}.`;
  }
  if (id === projectBuilderMemberId(projectId)) return `You work on project ${projectId}.`;
  if (id === projectManagerMemberId(projectId)) return `Your project is ${projectId}.`;
  if (id.startsWith(`bot-lead:${projectId}:`)) return `You lead work in project ${projectId}.`;
  return null;
};
const BUILDER_ROLE_ID = "role:builder";

/** How a bot's headquarters briefs a task it starts itself, when the person asks for one. */
const TASK_BRIEF =
  "You do one request in this worktree. Do small work yourself, commit it, and open a pull request; never merge or force-push. When the work needs planning, design or several steps, start a feature with t3_feature_start instead, and report that it started: the feature's lead runs it with its crew. Report what you did, or the question a person must answer.";

/** What a project's standing manager does; its run keeps the text it started with. */
const projectManagerTask = (projectId: ProjectId) =>
  `You are project ${projectId}'s manager. Each request arrives as its own message; until one does, there is nothing to do.`;

/** What a bot's headquarters does; its runs keep the text they started with. */
const headquartersTask = (botId: string) =>
  [
    `You run this bot's work across the projects it owns: the ones t3_project_list shows with botId "${botId}".`,
    `Hand each request for a project to its Project manager with t3_project_send: that projectId, the request with everything it needs to know, and a key you choose for the request (send the same key again on a retry). The Project manager picks a task, a feature or several, and replies here as the work moves. Start a task or a feature in a project yourself only when the person asks you to: a task with delegate_task, target.projectId set to that project and isolation "worktree", beginning its task with: "${TASK_BRIEF}"; a feature with t3_feature_start and that projectId. Link the thread the request went to, or the one you started, in your reply, then end your turn.`,
    `Start a new project with t3_project_create, or t3_project_clone then t3_project_create, with botId "${botId}".`,
    "When the person asks to create or change a role, do it with the t3_role_* tools if you're allowed to, then say what changed.",
    "Tell the person only what they must decide.",
  ].join("\n\n");

const BUILDER_WORKSPACE =
  "Work in this thread's workspace, and don't create worktrees or other checkouts. If it's a fresh worktree, install dependencies the way the project's instructions say before you build. Do the building yourself; use delegate_task subagents only for read-only work, such as research or reviewing your diff.";
const PLANNER_SPLIT =
  "If the work is too big for one builder, say so in your plan and propose splitting it into separate features, each with its own branch and pull request.";
/** Several crew threads run at once on one machine, so each keeps its checks and servers small. */
const CREW_CHECKS =
  "Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you finish.";
const crewInstructions = (name: string) =>
  `You are the ${name} on a feature's crew. Its lead gives you a task: do it in this thread's checkout, then end with a clear summary of the result and its evidence; that message goes back to the lead. If information is missing, say exactly what you need in that message instead of guessing. ${CREW_CHECKS}`;

/** A feature has one workspace and one builder; big work splits into features, not builders. */
const BUILDER_INSTRUCTIONS = `${crewInstructions("Builder")} ${BUILDER_WORKSPACE}`;
const PLANNER_INSTRUCTIONS = `${crewInstructions("Planner")} ${PLANNER_SPLIT}`;

/** Roles `ensureDefaults` creates when they are missing. People can edit or add more. */
const DEFAULT_ROLES = [
  {
    id: FEATURE_MANAGER_ROLE_ID,
    name: "Feature manager",
    allowedTools: [],
    instructions: FEATURE_MANAGER_INSTRUCTIONS,
  },
  {
    id: PROJECT_MANAGER_ROLE_ID,
    name: "Project manager",
    allowedTools: [],
    instructions: PROJECT_MANAGER_INSTRUCTIONS,
  },
  { id: "role:planner", name: "Planner", instructions: PLANNER_INSTRUCTIONS },
  { id: "role:designer", name: "Designer" },
  {
    id: BUILDER_ROLE_ID,
    name: "Builder",
    instructions: BUILDER_INSTRUCTIONS,
  },
  { id: "role:qa-tester", name: "QA Tester" },
  { id: "role:reviewer", name: "Reviewer" },
].map((role) => ({
  allowedTools: [],
  instructions: crewInstructions(role.name),
  ...role,
}));

export interface CreateCrewMemberInput {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly featureId?: string | null;
  readonly roleId?: string | null;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface CreateRoleInput {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

export interface CreateWorkflowInput {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly leadRoleId: string;
  readonly crewRoleIds: ReadonlyArray<string>;
}

export interface UpdateWorkflowInput extends CreateWorkflowInput {
  readonly expectedRevision: number;
}

export interface UpdateRoleInput extends CreateRoleInput {
  readonly expectedRevision: number;
  readonly enabled: boolean;
}

export interface CreateCrewRunInput {
  readonly id: string;
  readonly memberId: string;
  readonly projectId: ProjectId;
  readonly taskText: string;
  readonly modelSelection?: ModelSelection;
  /**
   * The delegator's access and model, used instead of the member's own. Not part of the
   * request's identity, so a retry matches after the delegator's settings change.
   */
  readonly carried?: { readonly runtimeMode: RuntimeMode; readonly modelSelection: ModelSelection };
  /** The thread's title; defaults to the member's name and the start of the task. */
  readonly title?: string;
  /** The worktree the thread opens in; the project's checkout when absent. */
  readonly workspace?: CrewWorkspace;
  readonly openingMessage?: OpeningMessage | null;
}

export interface CrewRunView {
  readonly run: CrewRun;
  readonly turnState: CrewTurnState;
  readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
}

export interface CrewServiceShape {
  /**
   * Creates the missing default roles, and gives bots without a model `modelSelection`. Existing
   * roles are left as people edited them.
   */
  readonly ensureDefaults: (
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, CrewServiceError>;
  /**
   * The project's Feature manager, made from its role on first use together with the
   * builder it delegates to. Captain may delegate to it.
   */
  readonly ensureFeatureManager: (
    projectId: ProjectId,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
  /** A person's request to the project's bot, which hands it to the project's Feature manager. */
  readonly startRequest: (input: {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
    readonly taskText: string;
  }) => Effect.Effect<CrewRun, CrewServiceError>;
  readonly createMember: (
    input: CreateCrewMemberInput,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
  readonly createRole: (input: CreateRoleInput) => Effect.Effect<Role, CrewServiceError>;
  readonly updateRole: (input: UpdateRoleInput) => Effect.Effect<Role, CrewServiceError>;
  readonly getMember: (id: string) => Effect.Effect<CrewMember | null, PersistenceSqlError>;
  readonly getRole: (id: string) => Effect.Effect<Role | null, PersistenceSqlError>;
  readonly listRoles: () => Effect.Effect<ReadonlyArray<Role>, PersistenceSqlError>;
  readonly createWorkflow: (
    input: CreateWorkflowInput,
  ) => Effect.Effect<Workflow, CrewServiceError>;
  readonly updateWorkflow: (
    input: UpdateWorkflowInput,
  ) => Effect.Effect<Workflow, CrewServiceError>;
  /** Feature delivery stays; features that follow a deleted workflow can't start their lead. */
  readonly deleteWorkflow: (id: string) => Effect.Effect<void, CrewServiceError>;
  readonly getWorkflow: (id: string) => Effect.Effect<Workflow | null, PersistenceSqlError>;
  readonly listWorkflows: () => Effect.Effect<ReadonlyArray<Workflow>, PersistenceSqlError>;
  /**
   * The project's member of a workflow's lead role: its Feature manager for that role,
   * else one made from the role on first use.
   */
  readonly ensureProjectLead: (
    projectId: ProjectId,
    roleId: string,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
  readonly instantiate: (
    id: string,
    projectId: ProjectId,
    roleId: string,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
  readonly allowDelegation: (
    sourceMemberId: string,
    targetMemberId: string,
  ) => Effect.Effect<void, CrewServiceError>;
  readonly revokeDelegation: (
    sourceMemberId: string,
    targetMemberId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listDelegationGrantsForProject: CrewStore["Service"]["listDelegationGrantsForProject"];
  readonly listHierarchyForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<CrewHierarchyNode>, PersistenceSqlError>;
  readonly setHierarchyParent: (
    memberId: string,
    parentMemberId: string | null,
    position?: number,
  ) => Effect.Effect<void, CrewServiceError>;
  /** The project's crew hierarchy and explicit delegation grants. */
  readonly projectConfiguration: (projectId: ProjectId) => Effect.Effect<
    {
      readonly hierarchy: ReadonlyArray<CrewHierarchyNode>;
      readonly delegationGrants: ReadonlyArray<CrewDelegationGrant>;
    },
    CrewServiceError
  >;
  /** Places a member of the project under another member, or at the top. */
  readonly placeInProject: (input: {
    readonly projectId: ProjectId;
    readonly memberId: string;
    readonly parentMemberId: string | null;
    readonly position: number;
  }) => Effect.Effect<void, CrewServiceError>;
  /** Grants or revokes delegation to a member of the project. */
  readonly setDelegationInProject: (input: {
    readonly projectId: ProjectId;
    readonly sourceMemberId: string;
    readonly targetMemberId: string;
    readonly allowed: boolean;
  }) => Effect.Effect<void, CrewServiceError>;
  readonly createRun: (input: CreateCrewRunInput) => Effect.Effect<CrewRun, CrewServiceError>;
  /**
   * The bot's headquarters run, created and pinned on first use, and restored if its thread
   * was deleted or archived. It lives in the Scratch project, or where there is none (a data
   * dir inside a checkout) in `fallbackProjectId` or another project the bot owns. It only
   * delegates into projects the bot owns, wherever it lives.
   */
  readonly ensureHeadquarters: (
    botId: string,
    fallbackProjectId?: ProjectId,
  ) => Effect.Effect<CrewRun, CrewServiceError>;
  /** Points an open headquarters at its bot's current runtime mode and model. */
  readonly syncHeadquarters: (botId: string) => Effect.Effect<void, CrewServiceError>;
  /**
   * The project's standing manager run, made with its member on first use, pinned in the
   * project and restored if its thread was deleted or archived. It works in the checkout.
   */
  readonly ensureProjectManager: (projectId: ProjectId) => Effect.Effect<CrewRun, CrewServiceError>;
  /** The project's manager settings, or the role's before the project has one. */
  readonly projectManagerSettings: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /** Saves the project's manager settings; role edits stop reaching it until it is reset. */
  readonly updateProjectManager: (
    input: ProjectManagerUpdateInput,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /** Takes the role's current settings again, and follows the role from then on. */
  readonly resetProjectManager: (
    input: ProjectManagerResetInput,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  readonly getRun: (
    id: string,
  ) => Effect.Effect<CrewRunView | null, PersistenceSqlError | ProjectionRepositoryError>;
  readonly reconcileRuns: () => Effect.Effect<void, PersistenceSqlError>;
  /**
   * For bots set to start a new session, starts a headquarters over once its conversation grows
   * long and it has been quiet a while. Other bots leave it to the provider's compaction.
   */
  readonly watchHeadquarters: () => Effect.Effect<void, never, Scope.Scope>;
  /** Starts a standing thread over in a fresh session now; refused while it works. */
  readonly startNewSession: (threadId: ThreadId) => Effect.Effect<void, CrewServiceError>;
}

export type CrewServiceError =
  | CrewValidationError
  | PersistenceSqlError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export class CrewService extends Context.Service<CrewService, CrewServiceShape>()(
  "t3/crew/CrewService",
) {}

const nonEmpty = (value: string, field: string, limit: number) => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) {
    throw new CrewValidationError(`${field} must contain 1-${limit} characters`);
  }
  return trimmed;
};

const validTools = (tools: ReadonlyArray<string> | undefined) => {
  const list = tools ?? [];
  if (list.length > 32) throw new CrewValidationError("Too many tools");
  return [...new Set(list.map((tool) => nonEmpty(tool, "Tool", 100)))];
};

/** Grants that act for the bot behind a run, which a role's members must never hold. */
const BOT_ONLY_GRANTS: ReadonlySet<string> = new Set(
  CREW_TOOL_GRANTS.filter((grant) => "botOnly" in grant).map((grant) => grant.id),
);
const validRoleTools = (tools: ReadonlyArray<string> | undefined) => {
  const list = validTools(tools);
  const botOnly = list.find((tool) => BOT_ONLY_GRANTS.has(tool));
  if (botOnly !== undefined) {
    throw new CrewValidationError(`${botOnly} is for bots and can't be given to a role`);
  }
  return list;
};

const sameRunRequest = (run: CrewRun, input: CreateCrewRunInput) =>
  run.memberId === input.memberId &&
  run.projectId === input.projectId &&
  run.taskText === input.taskText &&
  (input.modelSelection === undefined ||
    JSON.stringify(run.modelSelection) === JSON.stringify(input.modelSelection));

export const CrewServiceLive = Layer.effect(
  CrewService,
  Effect.gen(function* () {
    const store = yield* CrewStore;
    const runtime = yield* CrewThreadRuntime;
    const bots = yield* BotStore.BotStore;

    const threadInput = (run: CrewRun) => ({
      runId: run.id,
      memberId: run.memberId,
      threadId: run.threadId,
      projectId: run.projectId,
      title: run.title,
      prompt: crewRunPrompt(run),
      modelSelection: run.modelSelection,
      runtimeMode: run.runtimeMode,
      createdAt: run.createdAt,
      workspace: run.workspace,
      openingMessage: run.openingMessage ?? null,
    });

    const markDispatched = (
      run: CrewRun,
      effect: Effect.Effect<void, OrchestrationDispatchError | PersistenceSqlError>,
    ) =>
      effect.pipe(
        Effect.flatMap(() =>
          DateTime.now.pipe(
            Effect.flatMap((now) => store.markStarted(run.id, DateTime.formatIso(now))),
          ),
        ),
        Effect.tapError(() =>
          store.markDispatchError(run.id, "Thread dispatch failed; retry pending"),
        ),
      );

    const dispatch = (run: CrewRun) => markDispatched(run, runtime.start(threadInput(run)));
    const replayPending = (run: CrewRun) =>
      store
        .nextRecoveryAttempt(run.id)
        .pipe(
          Effect.flatMap((attempt) =>
            markDispatched(run, runtime.replayPending(threadInput(run), attempt)).pipe(
              Effect.result,
              Effect.asVoid,
            ),
          ),
        );

    const createMember: CrewServiceShape["createMember"] = Effect.fn("CrewService.createMember")(
      function* (input) {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Member ID", 128),
          catch: () => new CrewValidationError("Invalid crew member ID"),
        });
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Member name", 200),
          catch: () => new CrewValidationError("Invalid crew member name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Member instructions", 16_000),
          catch: () => new CrewValidationError("Invalid crew member instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => validTools(input.allowedTools),
          catch: () => new CrewValidationError("Invalid tool grants"),
        });
        const featureId = input.featureId ?? null;
        const roleId = input.roleId ?? null;
        if (featureId !== null && input.projectId === null) {
          return yield* Effect.fail(new CrewValidationError("A feature member needs a project"));
        }
        const role = roleId === null ? null : yield* store.getRole(roleId);
        if (roleId !== null && (!role || !role.enabled)) {
          return yield* Effect.fail(new CrewValidationError("Source role is unavailable"));
        }
        if (input.projectId !== null && !(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new CrewValidationError("Project does not exist"));
        }
        // Bots act in runs too, so a member can't take a bot's ID.
        if (yield* bots.idTaken(id)) {
          return yield* Effect.fail(new CrewValidationError("Crew member ID is in use"));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const member: CrewMember = {
          ...input,
          id,
          featureId,
          roleId,
          roleRevision: role?.revision ?? null,
          name,
          instructions,
          allowedTools,
          enabled: true,
          longConversation: "compact",
          customizedAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertMember(member);
        return member;
      },
    );

    /** Creates `input` unless a member with its ID exists, which must match its scope. */
    const ensureMember = Effect.fn("CrewService.ensureMember")(function* (
      input: CreateCrewMemberInput,
    ) {
      const existing = yield* store.getMember(input.id);
      if (existing) {
        if (existing.projectId !== input.projectId) {
          return yield* Effect.fail(new CrewValidationError("Default member ID is in use"));
        }
        return { member: existing, created: false };
      }
      const member = yield* createMember(input).pipe(
        // A concurrent caller may have created it first.
        Effect.catch((error) =>
          store.getMember(input.id).pipe(
            Effect.filterOrFail(
              (persisted): persisted is CrewMember => persisted?.projectId === input.projectId,
              () => error,
            ),
          ),
        ),
      );
      return { member, created: true };
    });

    const createRole: CrewServiceShape["createRole"] = Effect.fn("CrewService.createRole")(
      function* (input) {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Role ID", 128),
          catch: () => new CrewValidationError("Invalid role ID"),
        });
        if (yield* store.getRole(id)) {
          return yield* Effect.fail(new CrewValidationError(`Role ID is already in use: ${id}`));
        }
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Role name", 200),
          catch: () => new CrewValidationError("Invalid role name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Role instructions", 16_000),
          catch: () => new CrewValidationError("Invalid role instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => validRoleTools(input.allowedTools),
          catch: (cause) =>
            cause instanceof CrewValidationError
              ? cause
              : new CrewValidationError("Invalid tool grants"),
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        const role: Role = {
          ...input,
          id,
          name,
          instructions,
          allowedTools,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertRole(role);
        return role;
      },
    );

    /**
     * Brings a project-level member up to its role's revision. A member someone customized, or
     * one that changed under us, keeps what is stored.
     */
    const followRole = Effect.fn("CrewService.followRole")(function* (
      member: CrewMember,
      role: Role,
    ) {
      const context = projectMemberContext(member.id, member.projectId);
      if (context === null || member.roleRevision === role.revision) return member;
      const updated: CrewMember = {
        ...member,
        roleRevision: role.revision,
        name: role.name,
        instructions: `${role.instructions}\n\n${context}`,
        allowedTools: role.allowedTools,
        modelSelection: role.modelSelection,
        runtimeMode: role.runtimeMode,
        revision: member.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (yield* store.updateMember(updated, member.revision)) return updated;
      return (yield* store.getMember(member.id)) ?? member;
    });

    const updateRole: CrewServiceShape["updateRole"] = Effect.fn("CrewService.updateRole")(
      function* (input) {
        const previous = yield* store.getRole(input.id);
        if (!previous) {
          return yield* Effect.fail(new CrewValidationError(`Role not found: ${input.id}`));
        }
        if (previous.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            new CrewValidationError(
              `Role changed: it is at revision ${previous.revision}; reload and retry`,
            ),
          );
        }
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Role name", 200),
          catch: () => new CrewValidationError("Invalid role name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Role instructions", 16_000),
          catch: () => new CrewValidationError("Invalid role instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => validRoleTools(input.allowedTools),
          catch: (cause) =>
            cause instanceof CrewValidationError
              ? cause
              : new CrewValidationError("Invalid tool grants"),
        });
        const updated: Role = {
          ...previous,
          name,
          instructions,
          allowedTools,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          enabled: input.enabled,
          revision: previous.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        // Project-level members follow in the same transaction, so a standing run never sees
        // the new role with an old member.
        yield* store.transaction(
          Effect.gen(function* () {
            if (!(yield* store.updateRole(updated, previous.revision))) {
              return yield* Effect.fail(new CrewValidationError("Role changed; reload and retry"));
            }
            for (const member of yield* store.listProjectMembersOfRole(updated.id)) {
              yield* followRole(member, updated);
            }
          }),
        );
        // A project's open manager thread takes the role's new model and mode.
        if (updated.id === PROJECT_MANAGER_ROLE_ID) {
          for (const member of yield* store.listProjectMembersOfRole(updated.id)) {
            if (member.projectId !== null)
              yield* syncStanding(yield* projectOwner(member.projectId));
          }
        }
        return updated;
      },
    );

    /** The workflow's fields, checked, with its crew deduplicated and without its lead. */
    const workflowFields = Effect.fn("CrewService.workflowFields")(function* (
      input: CreateWorkflowInput,
    ) {
      const fields = yield* Effect.try({
        try: () => ({
          name: nonEmpty(input.name, "Workflow name", 200),
          instructions: nonEmpty(input.instructions, "Workflow instructions", 16_000),
        }),
        catch: () => new CrewValidationError("Give the workflow a name and instructions"),
      });
      if (!(yield* store.getRole(input.leadRoleId))) {
        return yield* Effect.fail(new CrewValidationError(`Role not found: ${input.leadRoleId}`));
      }
      // It manages a project from its own standing thread, never one feature.
      if (
        input.leadRoleId === PROJECT_MANAGER_ROLE_ID ||
        input.crewRoleIds.includes(PROJECT_MANAGER_ROLE_ID)
      ) {
        return yield* Effect.fail(
          new CrewValidationError("The Project manager can't lead a workflow or join its crew"),
        );
      }
      const crewRoleIds = [...new Set(input.crewRoleIds)].filter((id) => id !== input.leadRoleId);
      for (const id of crewRoleIds) {
        if (!(yield* store.getRole(id))) {
          return yield* Effect.fail(new CrewValidationError(`Role not found: ${id}`));
        }
      }
      return { ...fields, leadRoleId: input.leadRoleId, crewRoleIds };
    });

    const createWorkflow: CrewServiceShape["createWorkflow"] = Effect.fn(
      "CrewService.createWorkflow",
    )(function* (input) {
      const id = yield* Effect.try({
        try: () => nonEmpty(input.id, "Workflow ID", 128),
        catch: () => new CrewValidationError("Invalid workflow ID"),
      });
      if (yield* store.getWorkflow(id)) {
        return yield* Effect.fail(new CrewValidationError(`Workflow ID is already in use: ${id}`));
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const workflow: Workflow = {
        id,
        ...(yield* workflowFields(input)),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      yield* store.insertWorkflow(workflow);
      return workflow;
    });

    const updateWorkflow: CrewServiceShape["updateWorkflow"] = Effect.fn(
      "CrewService.updateWorkflow",
    )(function* (input) {
      const previous = yield* store.getWorkflow(input.id);
      if (!previous) {
        return yield* Effect.fail(new CrewValidationError(`Workflow not found: ${input.id}`));
      }
      const stale = new CrewValidationError(
        `Workflow changed: it is at revision ${previous.revision}; reload and retry`,
      );
      if (previous.revision !== input.expectedRevision) return yield* Effect.fail(stale);
      const updated: Workflow = {
        ...previous,
        ...(yield* workflowFields(input)),
        revision: previous.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (!(yield* store.updateWorkflow(updated, previous.revision))) {
        return yield* Effect.fail(stale);
      }
      return updated;
    });

    /** A member of `roleId` for the project, carrying the role's configuration. */
    const projectMemberFromRole = Effect.fn("CrewService.projectMemberFromRole")(function* (
      id: string,
      projectId: ProjectId,
      roleId: string,
    ) {
      const existing = yield* store.getMember(id);
      const role = yield* store.getRole(roleId);
      // An existing member keeps working even if its role was turned off since.
      if (existing?.projectId === projectId) {
        if (role === null) return { member: existing, created: false };
        return { member: yield* followRole(existing, role), created: false };
      }
      if (!role?.enabled) {
        return yield* Effect.fail(
          new CrewValidationError("Set up the crew before handing it project work"),
        );
      }
      return yield* ensureMember({
        id,
        projectId,
        roleId,
        name: role.name,
        instructions: `${role.instructions}\n\n${projectMemberContext(id, projectId)}`,
        allowedTools: role.allowedTools,
        modelSelection: role.modelSelection,
        runtimeMode: role.runtimeMode,
      });
    });

    const ensureFeatureManager: CrewServiceShape["ensureFeatureManager"] = Effect.fn(
      "CrewService.ensureFeatureManager",
    )(function* (projectId) {
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      const managerId = featureManagerMemberId(projectId);
      const builderId = projectBuilderMemberId(projectId);
      // Each part is ensured on every call, so a setup interrupted half way (or stopped by a
      // disabled role) is completed by the next request once the role is back.
      const manager = yield* projectMemberFromRole(managerId, projectId, FEATURE_MANAGER_ROLE_ID);
      const builder = yield* projectMemberFromRole(builderId, projectId, BUILDER_ROLE_ID);
      // The project's bot may delegate to the manager because it owns the project.
      yield* store.grantDelegation(managerId, builderId);
      if (builder.created) yield* store.setParent(builderId, managerId, 0);
      return manager.member;
    });

    /** The project's manager member, made from the Project manager role on first use. */
    const projectManagerMember = Effect.fn("CrewService.projectManagerMember")(function* (
      projectId: ProjectId,
    ) {
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      const { member } = yield* projectMemberFromRole(
        projectManagerMemberId(projectId),
        projectId,
        PROJECT_MANAGER_ROLE_ID,
      );
      return member;
    });

    const projectManagerSettings: CrewServiceShape["projectManagerSettings"] = Effect.fn(
      "CrewService.projectManagerSettings",
    )(function* (projectId) {
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      const run = yield* store.getRun(projectHeadquartersRunId(projectId));
      const threadId = run === null ? null : run.threadId;
      const member = yield* store.getMember(projectManagerMemberId(projectId));
      if (member !== null) {
        return {
          projectId,
          instructions: member.instructions,
          allowedTools: member.allowedTools,
          modelSelection: member.modelSelection,
          runtimeMode: member.runtimeMode,
          longConversation: member.longConversation,
          customized: member.customizedAt !== null,
          revision: member.revision,
          threadId,
        };
      }
      const role = yield* store.getRole(PROJECT_MANAGER_ROLE_ID);
      if (role === null) {
        return yield* Effect.fail(new CrewValidationError("Add the starter roles first"));
      }
      return {
        projectId,
        instructions: `${role.instructions}\n\n${projectMemberContext(projectManagerMemberId(projectId), projectId)}`,
        allowedTools: role.allowedTools,
        modelSelection: role.modelSelection,
        runtimeMode: role.runtimeMode,
        longConversation: "compact",
        customized: false,
        revision: 0,
        threadId,
      };
    });

    /**
     * Writes the project's manager while it is at `expectedRevision` (0 before it exists), then
     * points its open thread at the new model and mode.
     */
    const saveProjectManager = Effect.fn("CrewService.saveProjectManager")(function* (
      projectId: ProjectId,
      expectedRevision: number,
      change: (member: CrewMember, now: string) => Effect.Effect<CrewMember, CrewServiceError>,
    ) {
      const stale = new CrewValidationError(
        "The project manager changed; reload its settings and try again",
      );
      const existing = yield* store.getMember(projectManagerMemberId(projectId));
      if ((existing?.revision ?? 0) !== expectedRevision) return yield* Effect.fail(stale);
      const member = existing ?? (yield* projectManagerMember(projectId));
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* change(member, now);
      if (!(yield* store.saveMember(updated, member.revision))) return yield* Effect.fail(stale);
      yield* syncStanding(yield* projectOwner(projectId));
      return yield* projectManagerSettings(projectId);
    });

    const updateProjectManager: CrewServiceShape["updateProjectManager"] = Effect.fn(
      "CrewService.updateProjectManager",
    )(function* (input) {
      const instructions = yield* Effect.try({
        try: () => nonEmpty(input.instructions, "Instructions", 16_000),
        catch: () => new CrewValidationError("Give the project manager instructions"),
      });
      const allowedTools = yield* Effect.try({
        try: () => validRoleTools(input.allowedTools),
        catch: (cause) =>
          cause instanceof CrewValidationError
            ? cause
            : new CrewValidationError("Invalid tool grants"),
      });
      return yield* saveProjectManager(input.projectId, input.expectedRevision, (member, now) =>
        Effect.succeed({
          ...member,
          instructions,
          allowedTools,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          longConversation: input.longConversation,
          customizedAt: now,
          revision: member.revision + 1,
          updatedAt: now,
        }),
      );
    });

    const resetProjectManager: CrewServiceShape["resetProjectManager"] = Effect.fn(
      "CrewService.resetProjectManager",
    )(function* (input) {
      return yield* saveProjectManager(input.projectId, input.expectedRevision, (member, now) =>
        store.getRole(PROJECT_MANAGER_ROLE_ID).pipe(
          Effect.flatMap((role) =>
            role === null
              ? Effect.fail(new CrewValidationError("Add the starter roles first"))
              : Effect.succeed({
                  ...member,
                  roleRevision: role.revision,
                  name: role.name,
                  instructions: `${role.instructions}\n\n${projectMemberContext(member.id, member.projectId)}`,
                  allowedTools: role.allowedTools,
                  modelSelection: role.modelSelection,
                  runtimeMode: role.runtimeMode,
                  longConversation: "compact" as const,
                  customizedAt: null,
                  revision: member.revision + 1,
                  updatedAt: now,
                }),
          ),
        ),
      );
    });

    const ensureProjectLead: CrewServiceShape["ensureProjectLead"] = Effect.fn(
      "CrewService.ensureProjectLead",
    )(function* (projectId, roleId) {
      if (roleId === FEATURE_MANAGER_ROLE_ID) return yield* ensureFeatureManager(projectId);
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      const lead = yield* projectMemberFromRole(
        projectLeadMemberId(projectId, roleId),
        projectId,
        roleId,
      );
      return lead.member;
    });

    /**
     * Who acts in a new run: a crew member on the run's project (or an environment-wide one),
     * or the top-level bot that owns the project.
     */
    const runActor = Effect.fn("CrewService.runActor")(function* (
      id: string,
      projectId: ProjectId,
    ) {
      // Bots first: Captain's pre-bot member row can survive, disabled, as history.
      const bot = yield* bots.get(id);
      if (bot !== null) {
        if ((yield* bots.projectOwner(projectId)) !== bot.id) {
          return yield* Effect.fail(
            new CrewValidationError(`${bot.name} doesn't own this project`),
          );
        }
        return { ...bot, enabled: true };
      }
      const member = yield* store.getMember(id);
      if (member === null || !member.enabled) {
        return yield* Effect.fail(new CrewValidationError("Crew member is unavailable"));
      }
      if (member.projectId !== null && member.projectId !== projectId) {
        return yield* Effect.fail(
          new CrewValidationError("Crew member belongs to another project"),
        );
      }
      return member;
    });
    const modelFor = (
      actor: { readonly name: string; readonly modelSelection: ModelSelection | null },
      requested: ModelSelection | undefined,
    ) => {
      const model = requested ?? actor.modelSelection;
      return model
        ? Effect.succeed(model)
        : Effect.fail(new CrewValidationError(`Choose a default model for ${actor.name}`));
    };

    const createRun: CrewServiceShape["createRun"] = Effect.fn("CrewService.createRun")(
      function* (input) {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Run ID", 128),
          catch: () => new CrewValidationError("Invalid run ID"),
        });
        const taskText = yield* Effect.try({
          try: () => nonEmpty(input.taskText, "Task", 16_000),
          catch: () => new CrewValidationError("Invalid task"),
        });
        const request = { ...input, id, taskText };
        const existing = yield* store.getRun(id);
        if (existing !== null) {
          if (!sameRunRequest(existing, request)) {
            return yield* Effect.fail(new CrewValidationError("Run ID belongs to another request"));
          }
          if (existing.dispatchState === CREW_DISPATCH_STATE.QUEUED) yield* dispatch(existing);
          return (yield* store.getRun(id))!;
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new CrewValidationError("Project does not exist"));
        }
        const member = yield* runActor(input.memberId, input.projectId);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const run: CrewRun = {
          id,
          memberId: member.id,
          projectId: input.projectId,
          threadId: ThreadId.make(`bot-run:${id}`),
          taskText,
          title: input.title ?? `${member.name}: ${taskText.slice(0, 80)}`,
          instructions: member.instructions,
          allowedTools: member.allowedTools,
          memberRevision: member.revision,
          modelSelection: yield* modelFor(
            member,
            input.modelSelection ?? input.carried?.modelSelection,
          ),
          runtimeMode: input.carried?.runtimeMode ?? member.runtimeMode,
          dispatchState: CREW_DISPATCH_STATE.QUEUED,
          recoveryAttempt: 0,
          lastError: null,
          createdAt,
          dispatchedAt: null,
          workspace: input.workspace ?? null,
          openingMessage: input.openingMessage ?? null,
        };
        yield* store.insertRun(run);
        const persisted = yield* store.getRun(id);
        if (persisted === null || !sameRunRequest(persisted, request)) {
          return yield* Effect.fail(new CrewValidationError("Run ID belongs to another request"));
        }
        if (persisted.dispatchState === CREW_DISPATCH_STATE.QUEUED) yield* dispatch(persisted);
        return (yield* store.getRun(id))!;
      },
    );

    /**
     * Who a standing thread runs as: a bot for its headquarters, a project's manager member for
     * the project's. Its settings are read live, so an edit reaches the open thread.
     */
    interface StandingOwner {
      readonly runId: string;
      readonly threadId: ThreadId;
      readonly actorId: string;
      readonly name: string;
      readonly instructions: string;
      readonly allowedTools: ReadonlyArray<string>;
      readonly revision: number;
      readonly modelSelection: ModelSelection | null;
      readonly runtimeMode: RuntimeMode;
      readonly longConversation: BotLongConversation;
      readonly taskText: string;
      /** The project its thread lives in; a bot's headquarters moves if that one is deleted. */
      readonly home: Effect.Effect<ProjectId, CrewServiceError>;
    }

    const botOwner = Effect.fn("CrewService.botOwner")(function* (
      botId: string,
      fallbackProjectId?: ProjectId,
    ) {
      const bot = yield* bots.get(botId);
      if (bot === null) return null;
      const home = Effect.gen(function* () {
        const ownedProject = yield* bots.firstOwnedProject(bot.id);
        const projectId =
          (yield* runtime.headquartersProjectId) ??
          fallbackProjectId ??
          (ownedProject === null ? null : ProjectId.make(ownedProject));
        if (projectId === null) {
          return yield* Effect.fail(new CrewValidationError(`Give ${bot.name} a project first`));
        }
        return projectId;
      });
      return {
        runId: botHeadquartersRunId(bot.id),
        threadId: botHeadquartersThreadId(bot.id),
        actorId: bot.id,
        name: bot.name,
        instructions: bot.instructions,
        allowedTools: bot.allowedTools,
        revision: bot.revision,
        modelSelection: bot.modelSelection,
        runtimeMode: bot.runtimeMode,
        longConversation: bot.longConversation,
        taskText: headquartersTask(bot.id),
        home,
      } satisfies StandingOwner;
    });

    const projectOwner = Effect.fn("CrewService.projectOwner")(function* (projectId: ProjectId) {
      const member = yield* store.getMember(projectManagerMemberId(projectId));
      if (member === null) return null;
      return {
        runId: projectHeadquartersRunId(projectId),
        threadId: projectHeadquartersThreadId(projectId),
        actorId: member.id,
        name: "Project manager",
        instructions: member.instructions,
        allowedTools: member.allowedTools,
        revision: member.revision,
        modelSelection: member.modelSelection,
        runtimeMode: member.runtimeMode,
        longConversation: member.longConversation,
        taskText: projectManagerTask(projectId),
        home: runtime
          .projectExists(projectId)
          .pipe(
            Effect.flatMap((exists) =>
              exists
                ? Effect.succeed(projectId)
                : Effect.fail(new CrewValidationError("Project does not exist")),
            ),
          ),
      } satisfies StandingOwner;
    });

    const ownerOfThread = (threadId: ThreadId) => {
      const botId = headquartersBotId(threadId);
      if (botId !== null) return botOwner(botId);
      const projectId = headquartersProjectId(threadId);
      return projectId === null ? Effect.succeed(null) : projectOwner(projectId);
    };

    // One at a time, so two opens of a deleted standing thread restore it once.
    const standingLock = yield* Semaphore.make(1);
    /**
     * A standing run, created and pinned on first use, and restored if its thread was deleted
     * or archived. It restarts with its owner's instructions as they are then.
     */
    const ensureStanding = Effect.fn("CrewService.ensureStanding")(function* (
      owner: StandingOwner,
    ) {
      const id = owner.runId;
      // The run keeps its last model for decoding, so an owner without one is refused here.
      const modelSelection = yield* modelFor(owner, undefined);
      const existing = yield* store.getRun(id);
      // A standing run whose project was deleted moves, and `restore` restarts it there.
      if (existing !== null && !(yield* runtime.projectExists(existing.projectId))) {
        yield* store.moveRun(id, yield* owner.home);
      }
      if (existing === null) {
        yield* store.insertRun({
          id,
          memberId: owner.actorId,
          projectId: yield* owner.home,
          threadId: owner.threadId,
          taskText: owner.taskText,
          title: owner.name,
          instructions: owner.instructions,
          allowedTools: owner.allowedTools,
          memberRevision: owner.revision,
          modelSelection,
          runtimeMode: owner.runtimeMode,
          dispatchState: CREW_DISPATCH_STATE.QUEUED,
          recoveryAttempt: 0,
          lastError: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          dispatchedAt: null,
          // A project's manager works in the project's checkout.
          workspace: null,
          openingMessage: null,
        });
      }
      const run = (yield* store.getRun(id))!;
      if (run.dispatchState === CREW_DISPATCH_STATE.QUEUED) {
        yield* dispatch(run);
      } else {
        yield* runtime.restore({
          ...threadInput(run),
          prompt: `${owner.instructions}\n\nTask:\n${run.taskText}`,
        });
        yield* runtime.syncSettings(run.threadId, owner.runtimeMode, modelSelection);
      }
      yield* runtime
        .pin(run.threadId, `${id}:pin`)
        .pipe(Effect.catch((error) => Effect.logWarning("Standing pin failed", { id, error })));
      return (yield* store.getRun(id))!;
    }, standingLock.withPermits(1));

    const ensureHeadquarters: CrewServiceShape["ensureHeadquarters"] = Effect.fn(
      "CrewService.ensureHeadquarters",
    )(function* (botId, fallbackProjectId) {
      const owner = yield* botOwner(botId, fallbackProjectId);
      if (owner === null) return yield* Effect.fail(new CrewValidationError("Bot not found"));
      return yield* ensureStanding(owner);
    });

    const ensureProjectManager: CrewServiceShape["ensureProjectManager"] = Effect.fn(
      "CrewService.ensureProjectManager",
    )(function* (projectId) {
      yield* projectManagerMember(projectId);
      const owner = yield* projectOwner(projectId);
      if (owner === null) {
        return yield* Effect.fail(new CrewValidationError("Project manager is unavailable"));
      }
      return yield* ensureStanding(owner);
    });

    const startFresh = (
      owner: StandingOwner,
      run: CrewRun,
      records: FreshStartRecords,
      key: string,
    ) =>
      runtime.startFresh({
        threadId: run.threadId,
        runId: run.id,
        key,
        prompt: freshStartBriefing(
          `${owner.instructions}\n\nTask:\n${run.taskText}`,
          records.messages,
        ),
      });

    // A newer completed turn replaces the wait, so the quiet period restarts with each turn.
    const startFreshWhenQuiet = Effect.fn("CrewService.startFreshWhenQuiet")(
      function* (threadId: ThreadId, completedRunId: RunId) {
        const owner = yield* ownerOfThread(threadId);
        if (owner?.longConversation !== "new-session") return;
        if (!freshStartDue(yield* runtime.freshStartRecords(threadId), completedRunId)) return;
        yield* Effect.sleep(Duration.minutes(FRESH_START_QUIET_MINUTES));
        const records = yield* runtime.freshStartRecords(threadId);
        const current = yield* ownerOfThread(threadId);
        const run = yield* store.getRun(owner.runId);
        if (
          current?.longConversation !== "new-session" ||
          run?.threadId !== threadId ||
          !freshStartDue(records, completedRunId)
        )
          return;
        yield* startFresh(current, run, records, completedRunId);
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Standing thread fresh start skipped", { threadId, cause }),
          ),
        ),
    );

    const startNewSession: CrewServiceShape["startNewSession"] = Effect.fn(
      "CrewService.startNewSession",
    )(function* (threadId) {
      const owner = yield* ownerOfThread(threadId);
      if (owner === null) {
        return yield* Effect.fail(new CrewValidationError("Only a standing thread starts over"));
      }
      const run = yield* store.getRun(owner.runId);
      if (run === null || run.dispatchState !== CREW_DISPATCH_STATE.STARTED) {
        return yield* Effect.fail(new CrewValidationError(`${owner.name} has no thread yet`));
      }
      const records = yield* runtime.freshStartRecords(run.threadId);
      if (!headquartersIdle(records)) {
        return yield* Effect.fail(
          new CrewValidationError(`${owner.name} is working. Try again when it finishes.`),
        );
      }
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* startFresh(owner, run, records, `manual:${now}`);
    });

    /** Points an open standing thread at its owner's current runtime mode and model. */
    const syncStanding = Effect.fn("CrewService.syncStanding")(function* (
      owner: StandingOwner | null,
    ) {
      if (owner?.modelSelection == null) return;
      const run = yield* store.getRun(owner.runId);
      if (run?.dispatchState !== CREW_DISPATCH_STATE.STARTED) return;
      yield* runtime.syncSettings(run.threadId, owner.runtimeMode, owner.modelSelection);
    });

    const syncHeadquarters: CrewServiceShape["syncHeadquarters"] = Effect.fn(
      "CrewService.syncHeadquarters",
    )(function* (botId) {
      yield* syncStanding(yield* botOwner(botId));
    });

    const setHierarchyParent: CrewServiceShape["setHierarchyParent"] = Effect.fn(
      "CrewService.setHierarchyParent",
    )(function* (memberId, parentMemberId, position = 0) {
      const child = yield* store.getMember(memberId);
      const parent = parentMemberId === null ? null : yield* store.getMember(parentMemberId);
      if (!child?.enabled || (parentMemberId !== null && !parent?.enabled)) {
        return yield* Effect.fail(new CrewValidationError("Crew member is unavailable"));
      }
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position > 10_000 ||
        (parent &&
          ((child.projectId === null && parent.projectId !== null) ||
            (parent.projectId !== null && parent.projectId !== child.projectId) ||
            (parent.featureId !== null && parent.featureId !== child.featureId)))
      ) {
        return yield* Effect.fail(new CrewValidationError("Invalid hierarchy placement"));
      }
      if (!(yield* store.setParent(memberId, parentMemberId, position))) {
        return yield* Effect.fail(new CrewValidationError("Hierarchy cycle rejected"));
      }
    });

    const allowDelegation: CrewServiceShape["allowDelegation"] = Effect.fn(
      "CrewService.allowDelegation",
    )(function* (sourceMemberId, targetMemberId) {
      const source = yield* store.getMember(sourceMemberId);
      const target = yield* store.getMember(targetMemberId);
      if (
        !source ||
        !target ||
        !source.enabled ||
        !target.enabled ||
        sourceMemberId === targetMemberId ||
        (source.projectId !== null && target.projectId !== source.projectId)
      ) {
        return yield* Effect.fail(new CrewValidationError("Invalid delegation grant"));
      }
      yield* store.grantDelegation(sourceMemberId, targetMemberId);
    });

    const service = {
      ensureDefaults: Effect.fn("CrewService.ensureDefaults")(function* (modelSelection) {
        for (const role of DEFAULT_ROLES) {
          if (yield* store.getRole(role.id)) continue;
          // Stages run unattended, so starter roles don't stop for approvals.
          yield* createRole({ ...role, modelSelection, runtimeMode: "full-access" }).pipe(
            Effect.catch((error) =>
              store.getRole(role.id).pipe(Effect.filterOrFail(Predicate.isNotNull, () => error)),
            ),
          );
        }
        const builtIn: ReadonlyArray<CreateWorkflowInput> = [
          {
            id: FEATURE_DELIVERY_WORKFLOW_ID,
            name: "Feature delivery",
            instructions: FEATURE_DELIVERY_INSTRUCTIONS,
            leadRoleId: FEATURE_MANAGER_ROLE_ID,
            crewRoleIds: DEFAULT_ROLES.flatMap((role) =>
              role.id === FEATURE_MANAGER_ROLE_ID || role.id === PROJECT_MANAGER_ROLE_ID
                ? []
                : [role.id],
            ),
          },
          {
            id: EPIC_WORKFLOW_ID,
            name: "Epic",
            instructions: EPIC_INSTRUCTIONS,
            leadRoleId: FEATURE_MANAGER_ROLE_ID,
            crewRoleIds: ["role:planner", "role:qa-tester"],
          },
        ];
        for (const workflow of builtIn) {
          if (yield* store.getWorkflow(workflow.id)) continue;
          yield* createWorkflow(workflow).pipe(
            Effect.catch((error) =>
              store
                .getWorkflow(workflow.id)
                .pipe(Effect.filterOrFail(Predicate.isNotNull, () => error)),
            ),
          );
        }
        // Bots without a model can't run yet; give them the one the crew was set up with.
        const now = DateTime.formatIso(yield* DateTime.now);
        for (const bot of yield* bots.list) {
          if (bot.modelSelection !== null) continue;
          yield* bots.update(
            { ...bot, modelSelection, revision: bot.revision + 1, updatedAt: now },
            bot.revision,
          );
        }
      }),
      ensureFeatureManager,
      ensureProjectLead,
      startRequest: Effect.fn("CrewService.startRequest")(function* (input) {
        const existing = yield* store.getRun(input.id);
        // A retry of an accepted request must not depend on today's crew or owner.
        if (existing === null) yield* ensureFeatureManager(input.projectId);
        const memberId = existing?.memberId ?? (yield* bots.projectOwner(input.projectId));
        if (memberId === null) {
          return yield* Effect.fail(new CrewValidationError("Project does not exist"));
        }
        return yield* createRun({
          id: input.id,
          memberId,
          projectId: input.projectId,
          taskText: `Project: ${input.projectId}. Feature manager: ${featureManagerMemberId(input.projectId)}. Person's request: ${input.taskText}`,
          modelSelection: input.modelSelection,
        });
      }),
      createMember,
      createRole,
      updateRole,
      getMember: store.getMember,
      getRole: store.getRole,
      listRoles: store.listRoles,
      createWorkflow,
      updateWorkflow,
      deleteWorkflow: Effect.fn("CrewService.deleteWorkflow")(function* (id) {
        if (id === FEATURE_DELIVERY_WORKFLOW_ID) {
          return yield* Effect.fail(
            new CrewValidationError("Feature delivery can be edited but not deleted"),
          );
        }
        yield* store.deleteWorkflow(id);
      }),
      getWorkflow: store.getWorkflow,
      listWorkflows: store.listWorkflows,
      instantiate: Effect.fn("CrewService.instantiate")(function* (id, projectId, roleId) {
        const role = yield* store.getRole(roleId);
        if (!role?.enabled) {
          return yield* Effect.fail(new CrewValidationError("Source role is unavailable"));
        }
        return yield* createMember({
          id,
          projectId,
          roleId,
          name: role.name,
          instructions: role.instructions,
          allowedTools: role.allowedTools,
          modelSelection: role.modelSelection,
          runtimeMode: role.runtimeMode,
        });
      }),
      listDelegationGrantsForProject: store.listDelegationGrantsForProject,
      revokeDelegation: store.revokeDelegation,
      listHierarchyForProject: store.listHierarchyForProject,
      setHierarchyParent,
      projectConfiguration: Effect.fn("CrewService.projectConfiguration")(function* (projectId) {
        if (!(yield* runtime.projectExists(projectId))) {
          return yield* Effect.fail(new CrewValidationError("Project not found"));
        }
        const [hierarchy, delegationGrants] = yield* Effect.all([
          store.listHierarchyForProject(projectId),
          store.listDelegationGrantsForProject(projectId),
        ]);
        return { hierarchy, delegationGrants };
      }),
      placeInProject: Effect.fn("CrewService.placeInProject")(function* (input) {
        const child = yield* store.getMember(input.memberId);
        if (child?.projectId !== input.projectId) {
          return yield* Effect.fail(new CrewValidationError("Crew member not found in project"));
        }
        yield* setHierarchyParent(input.memberId, input.parentMemberId, input.position);
      }),
      setDelegationInProject: Effect.fn("CrewService.setDelegationInProject")(function* (input) {
        const target = yield* store.getMember(input.targetMemberId);
        if (target?.projectId !== input.projectId) {
          return yield* Effect.fail(new CrewValidationError("Crew member not found in project"));
        }
        if (input.allowed) yield* allowDelegation(input.sourceMemberId, input.targetMemberId);
        else yield* store.revokeDelegation(input.sourceMemberId, input.targetMemberId);
      }),
      allowDelegation,
      createRun,
      ensureHeadquarters,
      syncHeadquarters,
      ensureProjectManager,
      projectManagerSettings,
      updateProjectManager,
      resetProjectManager,
      getRun: (id) =>
        store.getRun(id).pipe(
          Effect.flatMap((run) =>
            run === null
              ? Effect.succeed(null)
              : runtime.getTurnState(run.threadId).pipe(
                  Effect.map((turnState) => ({
                    run,
                    turnState,
                    status:
                      run.dispatchState === CREW_DISPATCH_STATE.QUEUED
                        ? ("queued" as const)
                        : turnState === CREW_TURN_STATE.COMPLETED
                          ? ("completed" as const)
                          : turnState === CREW_TURN_STATE.ERROR ||
                              turnState === CREW_TURN_STATE.MISSING
                            ? ("failed" as const)
                            : turnState === CREW_TURN_STATE.INTERRUPTED
                              ? ("interrupted" as const)
                              : ("running" as const),
                  })),
                ),
          ),
        ),
      reconcileRuns: Effect.fn("CrewService.reconcileRuns")(function* () {
        // Recover accepted turns from a prior process before dispatching new queued runs.
        // Otherwise a newly dispatched turn could look stale before its reactor worker starts.
        let afterId = "";
        while (true) {
          const ids = yield* runtime.listPendingStartedRunIds(afterId, 100);
          if (ids.length === 0) break;
          yield* Effect.forEach(
            ids,
            (id) =>
              store
                .getRun(id)
                .pipe(Effect.flatMap((run) => (run === null ? Effect.void : replayPending(run)))),
            { concurrency: 1, discard: true },
          );
          afterId = ids[ids.length - 1]!;
        }
        const queued = yield* store.listQueuedRuns();
        yield* Effect.forEach(queued, (run) => dispatch(run).pipe(Effect.result), {
          concurrency: 1,
          discard: true,
        });
      }),
      startNewSession,
      watchHeadquarters: Effect.fn("CrewService.watchHeadquarters")(function* () {
        const waiting = yield* FiberMap.make<ThreadId>();
        yield* runtime.completedRuns.pipe(
          Stream.runForEach(({ threadId, runId }) =>
            isStandingThread(threadId)
              ? FiberMap.run(waiting, threadId, startFreshWhenQuiet(threadId, runId))
              : Effect.void,
          ),
          Effect.catch((cause) => Effect.logWarning("Headquarters watch stopped", { cause })),
          Effect.forkScoped,
        );
      }),
    } satisfies CrewServiceShape;
    // Library changes, and the bot models the defaults fill in, tell clients to re-read them.
    const changes = yield* crewChangeNotifier;
    const library = changes.notifying("library");
    return {
      ...service,
      ensureDefaults: changes.notifying("bots")(library(service.ensureDefaults)),
      createRole: library(service.createRole),
      updateRole: library(service.updateRole),
      createWorkflow: library(service.createWorkflow),
      updateWorkflow: library(service.updateWorkflow),
      deleteWorkflow: library(service.deleteWorkflow),
    } satisfies CrewServiceShape;
  }),
);
