import {
  botHeadquartersRunId,
  botHeadquartersThreadId,
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  headquartersBotId,
  headquartersProjectId,
  isStandingThread,
  EPIC_WORKFLOW_ID,
  FEATURE_DELIVERY_WORKFLOW_ID,
  PLANNER_ROLE_ID,
  ProjectId,
  projectHeadquartersRunId,
  projectHeadquartersThreadId,
  type ProjectManagerIconInput,
  type ProjectManagerResetInput,
  type ProjectManagerSettings,
  type ProjectManagerUpdateInput,
  ThreadId,
  type CrewTurnState,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";

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
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  freshStartBriefing,
  headquartersIdle,
  type FreshStartRecords,
} from "./headquartersFreshStart.ts";
import { crewChangeNotifier } from "./CrewChanges.ts";
import { CrewThreadRuntime, type OpeningMessage } from "./CrewThreadRuntime.ts";
import type { LinkedWorkflow } from "./linkedWorkflow.ts";
import {
  EPIC_INSTRUCTIONS,
  FEATURE_DELIVERY_INSTRUCTIONS,
  LINKED_REQUEST_INSTRUCTIONS,
  PROJECT_MANAGER_INSTRUCTIONS,
  projectManagerTask,
  crewMemberInstructions,
  crewRunPrompt,
  headquartersTask,
} from "./crewPrompts.ts";

// @effect-diagnostics-next-line extendsNativeError:off - Bosun error predating the Schema.TaggedError rule; migrating its call sites is follow-up work.
export class CrewValidationError extends Error {
  readonly _tag = "CrewValidationError";
}

/*
 * Member IDs below predate the Roles rename. They stay as they are because stored runs,
 * handoffs, grants and feature bindings reference them.
 */
/**
 * Who a linked machine's request runs as in one project. Its ID predates the Feature manager's
 * removal: retried requests carry it, and runs and grants reference it.
 */
export const linkedRequestMemberId = (projectId: ProjectId) => `bot-manager:${projectId}`;
/** A project's standing manager, made from the Project manager role on first use. */
export const projectManagerMemberId = (projectId: ProjectId) => `project-manager:${projectId}`;

const builtInManagerInstructions = (projectId: ProjectId) =>
  `${PROJECT_MANAGER_INSTRUCTIONS}\n\nYour project is ${projectId}.`;

/** A manager nobody customized follows the current built-in text, not the one it was saved with. */
export const managerInstructions = (
  member: Pick<CrewMember, "customizedAt" | "instructions">,
  projectId: ProjectId,
) => (member.customizedAt === null ? builtInManagerInstructions(projectId) : member.instructions);

const BUILDER_WORKSPACE =
  "Work in this thread's workspace, and don't create worktrees or other checkouts. If it's a fresh worktree, install dependencies the way the project's instructions say before you build. Do the building yourself; use delegate_task subagents only for read-only work, such as research or reviewing your diff.";
const PLANNER_SPLIT =
  "If the work is too big for one builder, say so in your plan and propose splitting it into separate features, each with its own branch and pull request.";
/** A feature has one workspace and one builder; big work splits into features, not builders. */
const BUILDER_INSTRUCTIONS = `${crewMemberInstructions("Builder")} ${BUILDER_WORKSPACE}`;
const PLANNER_INSTRUCTIONS = `${crewMemberInstructions("Planner")} ${PLANNER_SPLIT}`;

/** Roles `ensureDefaults` creates when they are missing. People can edit or add more. */
const DEFAULT_ROLES = [
  { id: PLANNER_ROLE_ID, name: "Planner", instructions: PLANNER_INSTRUCTIONS },
  { id: "role:designer", name: "Designer" },
  {
    id: "role:builder",
    name: "Builder",
    instructions: BUILDER_INSTRUCTIONS,
  },
  { id: "role:qa-tester", name: "QA Tester" },
  { id: "role:reviewer", name: "Reviewer" },
].map((role) => ({
  instructions: crewMemberInstructions(role.name),
  ...role,
}));

export interface CreateCrewMemberInput {
  readonly id: string;
  readonly projectId: ProjectId | null;
  readonly featureId?: string | null;
  readonly roleId?: string | null;
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly fallbackModelSelection?: ModelSelection | null;
}

export interface CreateRoleInput {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  /** Absent keeps an updated role's fallback model; null clears it. */
  readonly fallbackModelSelection?: ModelSelection | null;
}

export interface CreateWorkflowInput {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
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
  /**
   * The workflow a linked environment's bot sent with this request, kept before the run starts
   * so a feature its thread starts finds it. Not part of the request's identity.
   */
  readonly workflow?: LinkedWorkflow;
}

export interface CrewRunView {
  readonly run: CrewRun;
  readonly turnState: CrewTurnState;
  readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
}

/** Whether `fields` would change nothing a person sees, so the revision stays. */
const sameLibraryFields = <T extends object>(existing: T, fields: Partial<T>) =>
  Object.entries(fields).every(
    ([key, value]) => JSON.stringify(existing[key as keyof T]) === JSON.stringify(value),
  );

/** Workflows `ensureDefaults` creates when they are missing. */
const BUILT_IN_WORKFLOWS: ReadonlyArray<CreateWorkflowInput> = [
  {
    id: FEATURE_DELIVERY_WORKFLOW_ID,
    name: "Feature delivery",
    instructions: FEATURE_DELIVERY_INSTRUCTIONS,
    crewRoleIds: DEFAULT_ROLES.map((role) => role.id),
  },
  {
    id: EPIC_WORKFLOW_ID,
    name: "Epic",
    instructions: EPIC_INSTRUCTIONS,
    crewRoleIds: ["role:planner", "role:qa-tester"],
  },
];

/** A built-in every machine seeds for itself, still as it was seeded. */
export const isStock = (
  kind: "role" | "workflow",
  item: { readonly id: string; readonly name: string; readonly instructions: string } & Partial<
    Pick<Workflow, "crewRoleIds">
  >,
) =>
  kind === "role"
    ? DEFAULT_ROLES.some(
        (stock) =>
          stock.id === item.id &&
          stock.name === item.name &&
          stock.instructions === item.instructions,
      )
    : BUILT_IN_WORKFLOWS.some(
        (stock) =>
          stock.id === item.id &&
          sameLibraryFields(item, {
            name: stock.name,
            instructions: stock.instructions,
            crewRoleIds: stock.crewRoleIds,
          }),
      );

export interface CrewServiceShape {
  /**
   * Creates the missing default roles, and gives bots without a model `modelSelection`. Existing
   * roles are left as people edited them.
   */
  readonly ensureDefaults: (
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, CrewServiceError>;
  /**
   * Who a linked machine's request runs as in `projectId`: a built-in member, made on first use
   * with `modelSelection`, the model the request carries.
   */
  readonly ensureLinkedRequestMember: (
    projectId: ProjectId,
    modelSelection: ModelSelection,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
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
   * was deleted or archived. It lives in the bot's home, which it moves into from elsewhere.
   * It only delegates into projects the bot owns.
   */
  readonly ensureHeadquarters: (botId: string) => Effect.Effect<CrewRun, CrewServiceError>;
  /**
   * Moves every bot's headquarters that lives outside its home into it, with a fresh provider
   * session for its next turn. Starts no turn, and skips one that works until it is next opened.
   */
  readonly rehomeHeadquarters: () => Effect.Effect<void, CrewServiceError>;
  /** Points an open headquarters at its bot's current runtime mode and model. */
  readonly syncHeadquarters: (botId: string) => Effect.Effect<void, CrewServiceError>;
  /**
   * The project's standing manager run, made with its member on first use, pinned in the
   * project and restored if its thread was deleted or archived. It works in the checkout.
   * Scratch and bots' homes have none.
   */
  readonly ensureProjectManager: (projectId: ProjectId) => Effect.Effect<CrewRun, CrewServiceError>;
  /** Fails for a missing project, Scratch and a bot's home: the ones with no Project manager. */
  readonly requireManagedProject: (projectId: ProjectId) => Effect.Effect<void, CrewServiceError>;
  /** Like `requireManagedProject`, and fails while the project's manager is turned off. */
  readonly requireProjectManagerOn: (projectId: ProjectId) => Effect.Effect<void, CrewServiceError>;
  /** Turns the project's manager off, archiving its thread, or back on, restoring it. */
  readonly setProjectManagerEnabled: (input: {
    readonly projectId: ProjectId;
    readonly enabled: boolean;
  }) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /**
   * Archives the project's manager thread, as a move to another environment's copy does, and
   * returns it; null when the manager never had one. Its settings stay for a move back.
   */
  readonly archiveProjectManager: (
    projectId: ProjectId,
  ) => Effect.Effect<ThreadId | null, CrewServiceError>;
  /** Chooses the manager's look without marking it customized; null goes back to the derived one. */
  readonly setProjectManagerIcon: (
    input: ProjectManagerIconInput,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /** The project's manager settings, or the defaults before the project has one. */
  readonly projectManagerSettings: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /** Saves the project's manager settings; role edits stop reaching it until it is reset. */
  readonly updateProjectManager: (
    input: ProjectManagerUpdateInput,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /** Puts the project's manager back on the defaults: built-in instructions, its bot's model. */
  readonly resetProjectManager: (
    input: ProjectManagerResetInput,
  ) => Effect.Effect<ProjectManagerSettings, CrewServiceError>;
  /**
   * The instructions of the manager `callerThreadId` may change: its own when it is a project's
   * manager, or one of its projects' managers (`projectId`) when it is a bot's headquarters.
   */
  readonly projectManagerInstructions: (input: {
    readonly callerThreadId: ThreadId;
    /** A delegated child of the caller's thread; it never acts as the manager. */
    readonly callerIsSubagent?: boolean | undefined;
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<ProjectManagerInstructions, CrewServiceError>;
  /** Saves new instructions as a Settings edit would, keeping the manager's other settings. */
  readonly updateProjectManagerInstructions: (input: {
    readonly callerThreadId: ThreadId;
    readonly callerIsSubagent?: boolean | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly instructions: string;
    readonly expectedRevision: number;
  }) => Effect.Effect<ProjectManagerInstructions, CrewServiceError>;
  readonly getRun: (
    id: string,
  ) => Effect.Effect<CrewRunView | null, PersistenceSqlError | ProjectionRepositoryError>;
  /**
   * Cancels run `id` if it hasn't started: it is deleted, so neither `reconcileRuns` nor anything
   * else starts it. Null when there is no such run; `started` says whether its thread exists.
   */
  readonly cancelQueuedRun: (
    id: string,
  ) => Effect.Effect<
    { readonly run: CrewRun; readonly started: boolean } | null,
    PersistenceSqlError
  >;
  readonly reconcileRuns: () => Effect.Effect<void, PersistenceSqlError>;
  /** Starts a standing thread over in a fresh session now; refused while it works. */
  readonly startNewSession: (threadId: ThreadId) => Effect.Effect<void, CrewServiceError>;
}

export interface ProjectManagerInstructions {
  readonly projectId: ProjectId;
  readonly instructions: string;
  readonly revision: number;
  readonly customized: boolean;
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

// Not the model: a run may hold the fallback model instead of the one requested.
const sameRunRequest = (run: CrewRun, input: CreateCrewRunInput) =>
  run.memberId === input.memberId &&
  run.projectId === input.projectId &&
  run.taskText === input.taskText;

export const CrewServiceLive = Layer.effect(
  CrewService,
  Effect.gen(function* () {
    const store = yield* CrewStore;
    const runtime = yield* CrewThreadRuntime;
    const bots = yield* BotStore.BotStore;
    const environment = yield* Effect.serviceOption(ServerEnvironment);

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
        Effect.flatMap(() => DateTime.now),
        Effect.flatMap((now) =>
          store.markStarted(run.id, DateTime.formatIso(now)).pipe(
            // Its record was deleted meanwhile, as a cancelled queued run's is: the thread this
            // dispatch just made must not keep running.
            Effect.flatMap((marked) =>
              marked
                ? Effect.void
                : runtime.interrupt(run.threadId, `cancelled:${run.id}`, DateTime.formatIso(now)),
            ),
          ),
        ),
        Effect.tapError(() =>
          store.markDispatchError(run.id, "Thread dispatch failed; retry pending"),
        ),
      );

    // Read again just before it starts, so a run cancelled meanwhile stays unstarted.
    const dispatch = (run: CrewRun) =>
      store
        .getRun(run.id)
        .pipe(
          Effect.flatMap((current) =>
            current?.dispatchState === CREW_DISPATCH_STATE.QUEUED
              ? markDispatched(run, runtime.start(threadInput(run)))
              : Effect.void,
          ),
        );
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
          fallbackModelSelection: input.fallbackModelSelection ?? null,
          enabled: true,
          icon: null,
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
        const now = DateTime.formatIso(yield* DateTime.now);
        const role: Role = {
          id,
          name,
          instructions,
          modelSelection: input.modelSelection,
          fallbackModelSelection: input.fallbackModelSelection ?? null,
          enabled: true,
          importedFrom: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertRole(role);
        return role;
      },
    );

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
        const updated: Role = {
          ...previous,
          name,
          instructions,
          modelSelection: input.modelSelection,
          fallbackModelSelection:
            input.fallbackModelSelection === undefined
              ? previous.fallbackModelSelection
              : input.fallbackModelSelection,
          enabled: input.enabled,
          revision: previous.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!(yield* store.updateRole(updated, previous.revision))) {
          return yield* Effect.fail(new CrewValidationError("Role changed; reload and retry"));
        }
        return updated;
      },
    );

    /** The workflow's fields, checked, with its crew deduplicated. */
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
      const crewRoleIds = [...new Set(input.crewRoleIds)];
      for (const id of crewRoleIds) {
        if (!(yield* store.getRole(id))) {
          return yield* Effect.fail(new CrewValidationError(`Role not found: ${id}`));
        }
      }
      return { ...fields, crewRoleIds };
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
        importedFrom: null,
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

    const ensureLinkedRequestMember: CrewServiceShape["ensureLinkedRequestMember"] = Effect.fn(
      "CrewService.ensureLinkedRequestMember",
    )(function* (projectId, modelSelection) {
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      const id = linkedRequestMemberId(projectId);
      const fields = {
        roleId: null,
        roleRevision: null,
        name: "Linked request",
        instructions: `${LINKED_REQUEST_INSTRUCTIONS}\n\nYour project is ${projectId}.`,
        enabled: true,
      };
      const existing = yield* store.getMember(id);
      if (existing === null) {
        const { member } = yield* ensureMember({ id, projectId, ...fields, modelSelection });
        return member;
      }
      if (existing.projectId !== projectId) {
        return yield* Effect.fail(new CrewValidationError("Default member ID is in use"));
      }
      // One made from the Feature manager role, before it was removed, takes the built-in text.
      if (sameLibraryFields(existing, fields)) return existing;
      const updated: CrewMember = {
        ...existing,
        ...fields,
        revision: existing.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (yield* store.updateMember(updated, existing.revision)) return updated;
      return (yield* store.getMember(id)) ?? existing;
    });

    /** Fails for a missing project, Scratch and a bot's home. */
    const requireManagedProject = Effect.fn("CrewService.requireManagedProject")(function* (
      projectId: ProjectId,
    ) {
      if (!(yield* runtime.projectExists(projectId))) {
        return yield* Effect.fail(new CrewValidationError("Project does not exist"));
      }
      if (yield* runtime.isHiddenProject(projectId)) {
        return yield* Effect.fail(
          new CrewValidationError("Scratch and bot homes have no Project manager"),
        );
      }
    });

    /** What a project's manager starts with: built-in instructions. */
    const projectManagerDefaults = (projectId: ProjectId) => ({
      instructions: builtInManagerInstructions(projectId),
    });

    /**
     * The model stored on a new manager member's row. Its thread opens on the model a new thread
     * in the project gets and its composer picks from then on, so nothing reads this one.
     */
    const projectManagerRowModel = Effect.fn("CrewService.projectManagerRowModel")(function* (
      projectId: ProjectId,
    ) {
      const botId = yield* runtime.projectBotId(projectId);
      const bot = botId === null ? null : yield* bots.get(botId);
      const modelSelection =
        bot?.modelSelection ?? (yield* runtime.projectModelSelection(projectId));
      if (modelSelection === null) {
        if (bot === null) {
          return yield* Effect.fail(
            new CrewValidationError("Choose a default model for this project or in Settings"),
          );
        }
        const machine = Option.isSome(environment)
          ? ` on ${(yield* environment.value.getDescriptor).label}`
          : "";
        return yield* Effect.fail(
          new CrewValidationError(`${bot.name}${machine} has no default model`),
        );
      }
      return modelSelection;
    });

    const projectManagerMember = Effect.fn("CrewService.projectManagerMember")(function* (
      projectId: ProjectId,
    ) {
      yield* requireManagedProject(projectId);
      const existing = yield* store.getMember(projectManagerMemberId(projectId));
      if (existing !== null) return existing;
      const { member } = yield* ensureMember({
        id: projectManagerMemberId(projectId),
        projectId,
        roleId: null,
        name: "Project manager",
        instructions: projectManagerDefaults(projectId).instructions,
        modelSelection: yield* projectManagerRowModel(projectId),
      });
      return member;
    });

    const projectManagerSettings: CrewServiceShape["projectManagerSettings"] = Effect.fn(
      "CrewService.projectManagerSettings",
    )(function* (projectId) {
      yield* requireManagedProject(projectId);
      const run = yield* store.getRun(projectHeadquartersRunId(projectId));
      const threadId = run === null ? null : run.threadId;
      const member = yield* store.getMember(projectManagerMemberId(projectId));
      if (member !== null) {
        return {
          projectId,
          enabled: member.enabled,
          instructions: managerInstructions(member, projectId),
          customized: member.customizedAt !== null,
          revision: member.revision,
          threadId,
          icon: member.icon,
        };
      }
      return {
        projectId,
        enabled: true,
        ...projectManagerDefaults(projectId),
        customized: false,
        revision: 0,
        threadId,
        icon: null,
      };
    });

    /** Writes the project's manager while it is at `expectedRevision` (0 before it exists). */
    const saveProjectManager = Effect.fn("CrewService.saveProjectManager")(function* (
      projectId: ProjectId,
      expectedRevision: number,
      change: (member: CrewMember, now: string) => Effect.Effect<CrewMember, CrewServiceError>,
    ) {
      const stale = new CrewValidationError(
        "The project manager changed; reload its settings and try again",
      );
      yield* requireManagedProject(projectId);
      const existing = yield* store.getMember(projectManagerMemberId(projectId));
      if ((existing?.revision ?? 0) !== expectedRevision) return yield* Effect.fail(stale);
      const member = existing ?? (yield* projectManagerMember(projectId));
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* change(member, now);
      // A member made here starts at revision 1; one someone else made and changed meanwhile is stale.
      if (!(yield* store.saveMember(updated, existing?.revision ?? 1))) {
        return yield* Effect.fail(stale);
      }
      return yield* projectManagerSettings(projectId);
    });

    const updateProjectManager: CrewServiceShape["updateProjectManager"] = Effect.fn(
      "CrewService.updateProjectManager",
    )(function* (input) {
      const instructions = yield* Effect.try({
        try: () => nonEmpty(input.instructions, "Instructions", 16_000),
        catch: () => new CrewValidationError("Give the project manager instructions"),
      });
      return yield* saveProjectManager(input.projectId, input.expectedRevision, (member, now) =>
        Effect.succeed({
          ...member,
          instructions,
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
        Effect.succeed({
          ...member,
          ...projectManagerDefaults(input.projectId),
          customizedAt: null,
          revision: member.revision + 1,
          updatedAt: now,
        }),
      );
    });

    /** Which project's manager the caller may change: its own, or its bot's project's. */
    const instructionsProject = Effect.fn("CrewService.instructionsProject")(function* (input: {
      readonly callerThreadId: ThreadId;
      readonly callerIsSubagent?: boolean | undefined;
      readonly projectId?: ProjectId | undefined;
    }) {
      const { callerThreadId, projectId } = input;
      if (input.callerIsSubagent === true) {
        return yield* Effect.fail(
          new CrewValidationError("A subagent can't change a project manager's instructions"),
        );
      }
      const own = headquartersProjectId(callerThreadId);
      if (own !== null) {
        if (projectId !== undefined && projectId !== own) {
          return yield* Effect.fail(
            new CrewValidationError(
              "A project manager reads and changes only its own instructions",
            ),
          );
        }
        return own;
      }
      const botId = headquartersBotId(callerThreadId);
      if (botId === null) {
        return yield* Effect.fail(
          new CrewValidationError(
            "Only a project's manager, or the headquarters of the bot that owns the project, changes its instructions",
          ),
        );
      }
      if (projectId === undefined) {
        return yield* Effect.fail(
          new CrewValidationError("Name the projectId of one of this bot's projects"),
        );
      }
      if ((yield* runtime.projectBotId(projectId)) !== botId) {
        return yield* Effect.fail(
          new CrewValidationError(`Project ${projectId} isn't one of this bot's projects`),
        );
      }
      return projectId;
    });

    const instructionsOf = (settings: ProjectManagerSettings): ProjectManagerInstructions => ({
      projectId: settings.projectId,
      instructions: settings.instructions,
      revision: settings.revision,
      customized: settings.customized,
    });

    const projectManagerInstructions: CrewServiceShape["projectManagerInstructions"] = Effect.fn(
      "CrewService.projectManagerInstructions",
    )(function* (input) {
      const projectId = yield* instructionsProject(input);
      return instructionsOf(yield* projectManagerSettings(projectId));
    });

    const updateProjectManagerInstructions: CrewServiceShape["updateProjectManagerInstructions"] =
      Effect.fn("CrewService.updateProjectManagerInstructions")(function* (input) {
        const projectId = yield* instructionsProject(input);
        const current = yield* projectManagerSettings(projectId);
        if (current.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            new CrewValidationError(
              `The instructions changed since you read them (now revision ${current.revision}). Read them again, make your change on that text, and save it with the new revision.`,
            ),
          );
        }
        const saved = yield* updateProjectManager({
          projectId,
          instructions: input.instructions,
          expectedRevision: input.expectedRevision,
        });
        return instructionsOf(saved);
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
    /**
     * The model one run uses: the requested model, else the actor's, else the one a new thread in
     * the project gets, switched to the fallback while that can't run here. The actor's saved
     * model stays as it is.
     */
    const modelFor = Effect.fn("CrewService.modelFor")(function* (
      actor: {
        readonly name: string;
        readonly modelSelection: ModelSelection | null;
        readonly fallbackModelSelection?: ModelSelection | null;
      },
      requested: ModelSelection | undefined,
      projectId: ProjectId,
    ) {
      const model = yield* runtime.runModelSelection(
        projectId,
        requested ?? actor.modelSelection,
        actor.fallbackModelSelection,
      );
      if (model === null) {
        return yield* Effect.fail(
          new CrewValidationError(
            `No provider is available to run ${actor.name}. Set one up in Settings.`,
          ),
        );
      }
      return model;
    });

    /** Run `id` as stored now; a run cancelled before it started fails instead. */
    const currentRun = (id: string) =>
      store.getRun(id).pipe(
        Effect.filterOrFail(
          (run): run is CrewRun => run !== null,
          () => new CrewValidationError("Run was cancelled before it started"),
        ),
      );

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
          return yield* currentRun(id);
        }
        if (!(yield* runtime.projectExists(input.projectId))) {
          return yield* Effect.fail(new CrewValidationError("Project does not exist"));
        }
        const member = yield* runActor(input.memberId, input.projectId);
        if (input.workflow !== undefined) yield* store.setRunWorkflow(id, input.workflow);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const model = yield* modelFor(
          member,
          input.modelSelection ?? input.carried?.modelSelection,
          input.projectId,
        );
        const run: CrewRun = {
          id,
          memberId: member.id,
          projectId: input.projectId,
          threadId: ThreadId.make(`bot-run:${id}`),
          taskText,
          title: input.title ?? `${member.name}: ${taskText.slice(0, 80)}`,
          instructions: member.instructions,
          memberRevision: member.revision,
          modelSelection: model.selection,
          runtimeMode: input.carried?.runtimeMode ?? "full-access",
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
        const blocked = model.blocked;
        if (persisted.dispatchState === CREW_DISPATCH_STATE.QUEUED) {
          const dispatched = dispatch(persisted);
          // A provider turned off refuses the launch outright; who asked hears why, and the run
          // is dropped so recovery never starts it later.
          yield* blocked === null
            ? dispatched
            : dispatched.pipe(
                Effect.catch(() =>
                  store
                    .deleteQueuedRun(id)
                    .pipe(Effect.andThen(Effect.fail(new CrewValidationError(blocked)))),
                ),
              );
        }
        // Neither its model nor the fallback can run here: it starts anyway and fails in its own thread.
        const notice =
          model.notice ??
          (blocked === null
            ? null
            : { title: "No model can run", message: blocked, level: "error" as const });
        if (notice !== null)
          yield* runtime.noteModelFallback(persisted.threadId, model.selection, notice);
        return yield* currentRun(id);
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
      readonly revision: number;
      /** Null opens its thread on the default model. */
      readonly modelSelection: ModelSelection | null;
      readonly taskText: string;
      /** The project its thread lives in: a bot's home, made again if it was deleted. */
      readonly home: Effect.Effect<ProjectId, CrewServiceError>;
    }

    /**
     * The bot's home, with its headquarters run and thread moved in from wherever they were.
     * A headquarters that works stays put until it is next opened.
     */
    const rehome = Effect.fn("CrewService.rehome")(function* (bot: {
      readonly id: string;
      readonly name: string;
    }) {
      const home = yield* runtime
        .botHome(bot)
        .pipe(Effect.mapError((error) => new CrewValidationError(error.message)));
      const run = yield* store.getRun(botHeadquartersRunId(bot.id));
      if (run === null || run.projectId === home) return home;
      const moved = yield* runtime.moveThread({
        threadId: run.threadId,
        projectId: home,
        key: `bot-home:${bot.id}:${run.projectId}`,
      });
      if (moved) yield* store.moveRun(run.id, home);
      return home;
    });

    const botOwner = Effect.fn("CrewService.botOwner")(function* (botId: string) {
      const bot = yield* bots.get(botId);
      if (bot === null) return null;
      const home = rehome(bot);
      return {
        runId: botHeadquartersRunId(bot.id),
        threadId: botHeadquartersThreadId(bot.id),
        actorId: bot.id,
        name: bot.name,
        instructions: bot.instructions,
        revision: bot.revision,
        modelSelection: bot.modelSelection,
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
        instructions: managerInstructions(member, projectId),
        revision: member.revision,
        // Its thread's composer picks its model from then on.
        modelSelection: null,
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
     * A standing run, created on first use with no turn, and restored if its thread was deleted
     * or archived. A bot's headquarters is pinned; a project's manager is reached from the
     * sidebar header instead, so one pinned before that is unpinned once.
     */
    const ensureStanding = Effect.fn("CrewService.ensureStanding")(function* (
      owner: StandingOwner,
    ) {
      const id = owner.runId;
      const existing = yield* store.getRun(id);
      const home = yield* owner.home;
      // Resolved on every open, so an owner without a model follows the default until one is set.
      const model = yield* modelFor(owner, undefined, home);
      const modelSelection = model.selection;
      // A standing run whose project was deleted moves, and `restore` restarts it there.
      if (existing !== null && !(yield* runtime.projectExists(existing.projectId))) {
        yield* store.moveRun(id, home);
      }
      if (existing !== null && existing.instructions !== owner.instructions) {
        yield* store.setRunInstructions(id, owner.instructions);
      }
      if (existing === null) {
        yield* store.insertRun({
          id,
          memberId: owner.actorId,
          projectId: home,
          threadId: owner.threadId,
          taskText: owner.taskText,
          title: owner.name,
          instructions: owner.instructions,
          memberRevision: owner.revision,
          modelSelection,
          runtimeMode: "full-access",
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
      // The stored run reads its owner's saved model; this open uses the one that can run.
      const run = { ...(yield* store.getRun(id))!, modelSelection };
      if (run.dispatchState === CREW_DISPATCH_STATE.QUEUED) {
        yield* dispatch(run);
        if (model.notice !== null)
          yield* runtime.noteModelFallback(run.threadId, modelSelection, model.notice);
      } else {
        yield* runtime.restore(threadInput(run));
        // The thread's own model stands: it moves to the fallback only from the automatic choice.
        if (model.notice !== null) {
          const automatic =
            owner.modelSelection ?? (yield* runtime.projectModelSelection(run.projectId));
          const switched =
            automatic !== null &&
            (yield* runtime.setModel(run.threadId, modelSelection, { from: automatic }));
          if (switched)
            yield* runtime.noteModelFallback(run.threadId, modelSelection, model.notice);
        }
      }
      yield* (
        headquartersBotId(run.threadId) === null
          ? runtime.unpin(run.threadId, `${id}:unpin`)
          : runtime.pin(run.threadId, `${id}:pin`)
      ).pipe(Effect.catch((error) => Effect.logWarning("Standing pin failed", { id, error })));
      return { ...(yield* store.getRun(id))!, modelSelection };
    }, standingLock.withPermits(1));

    const ensureHeadquarters: CrewServiceShape["ensureHeadquarters"] = Effect.fn(
      "CrewService.ensureHeadquarters",
    )(function* (botId) {
      const owner = yield* botOwner(botId);
      if (owner === null) return yield* Effect.fail(new CrewValidationError("Bot not found"));
      return yield* ensureStanding(owner);
    });

    const rehomeHeadquarters: CrewServiceShape["rehomeHeadquarters"] = Effect.fn(
      "CrewService.rehomeHeadquarters",
    )(function* () {
      for (const bot of yield* bots.list) {
        if ((yield* store.getRun(botHeadquartersRunId(bot.id))) === null) continue;
        yield* standingLock
          .withPermits(1)(rehome(bot))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Bot headquarters stayed outside its home", {
                botId: bot.id,
                error,
              }),
            ),
          );
      }
    });

    const projectManagerOff = (projectId: ProjectId) =>
      new CrewValidationError(
        `Project ${projectId}'s manager is turned off. Do this work yourself: start a task or a feature in the project.`,
      );

    /** A copy whose manager lives on another environment has none of its own. */
    const requireManagerHere = Effect.fn("CrewService.requireManagerHere")(function* (
      projectId: ProjectId,
    ) {
      const home = yield* runtime.projectRemoteManager(projectId);
      if (home === null) return;
      return yield* Effect.fail(
        new CrewValidationError(
          `Project ${projectId}'s manager lives on ${home.homeLabel}, so this copy has none of its own. Ask that manager, or start a task or a feature here yourself.`,
        ),
      );
    });

    const requireProjectManagerOn: CrewServiceShape["requireProjectManagerOn"] = Effect.fn(
      "CrewService.requireProjectManagerOn",
    )(function* (projectId) {
      yield* requireManagedProject(projectId);
      yield* requireManagerHere(projectId);
      const member = yield* store.getMember(projectManagerMemberId(projectId));
      if (member?.enabled === false) return yield* Effect.fail(projectManagerOff(projectId));
    });

    const setProjectManagerEnabled: CrewServiceShape["setProjectManagerEnabled"] = Effect.fn(
      "CrewService.setProjectManagerEnabled",
    )(function* ({ projectId, enabled }) {
      const member = yield* projectManagerMember(projectId);
      if (member.enabled !== enabled) {
        const updated: CrewMember = {
          ...member,
          enabled,
          revision: member.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!(yield* store.saveMember(updated, member.revision))) {
          return yield* Effect.fail(
            new CrewValidationError(
              "The project manager changed; reload its settings and try again",
            ),
          );
        }
      }
      const run = yield* store.getRun(projectHeadquartersRunId(projectId));
      if (run !== null) {
        if (enabled) {
          const owner = yield* projectOwner(projectId);
          if (owner !== null) yield* ensureStanding(owner);
        } else {
          yield* runtime.archive(run.threadId);
        }
      }
      return yield* projectManagerSettings(projectId);
    });

    const archiveProjectManager: CrewServiceShape["archiveProjectManager"] = Effect.fn(
      "CrewService.archiveProjectManager",
    )(function* (projectId) {
      const run = yield* store.getRun(projectHeadquartersRunId(projectId));
      if (run === null) return null;
      yield* runtime.archive(run.threadId);
      return run.threadId;
    });

    const setProjectManagerIcon: CrewServiceShape["setProjectManagerIcon"] = Effect.fn(
      "CrewService.setProjectManagerIcon",
    )(function* ({ projectId, icon }) {
      const member = yield* projectManagerMember(projectId);
      const updated: CrewMember = {
        ...member,
        icon,
        revision: member.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (!(yield* store.saveMember(updated, member.revision))) {
        return yield* Effect.fail(
          new CrewValidationError("The project manager changed; reload its settings and try again"),
        );
      }
      return yield* projectManagerSettings(projectId);
    });

    const ensureProjectManager: CrewServiceShape["ensureProjectManager"] = Effect.fn(
      "CrewService.ensureProjectManager",
    )(function* (projectId) {
      const member = yield* projectManagerMember(projectId);
      if (!member.enabled) return yield* Effect.fail(projectManagerOff(projectId));
      yield* requireManagerHere(projectId);
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

    const syncHeadquarters: CrewServiceShape["syncHeadquarters"] = Effect.fn(
      "CrewService.syncHeadquarters",
    )(function* (botId) {
      const owner = yield* botOwner(botId);
      if (owner === null) return;
      const run = yield* store.getRun(owner.runId);
      if (run?.dispatchState !== CREW_DISPATCH_STATE.STARTED) return;
      const model = yield* modelFor(owner, undefined, run.projectId);
      const switched = yield* runtime.setModel(run.threadId, model.selection);
      if (switched && model.notice !== null)
        yield* runtime.noteModelFallback(run.threadId, model.selection, model.notice);
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
          yield* createRole({ ...role, modelSelection }).pipe(
            Effect.catch((error) =>
              store.getRole(role.id).pipe(Effect.filterOrFail(Predicate.isNotNull, () => error)),
            ),
          );
        }
        for (const workflow of BUILT_IN_WORKFLOWS) {
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
      ensureLinkedRequestMember,
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
          modelSelection: role.modelSelection,
          fallbackModelSelection: role.fallbackModelSelection,
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
      rehomeHeadquarters,
      syncHeadquarters,
      ensureProjectManager,
      requireProjectManagerOn,
      setProjectManagerEnabled,
      archiveProjectManager,
      setProjectManagerIcon,
      requireManagedProject,
      projectManagerSettings,
      updateProjectManager,
      resetProjectManager,
      projectManagerInstructions,
      updateProjectManagerInstructions,
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
      cancelQueuedRun: Effect.fn("CrewService.cancelQueuedRun")(function* (id) {
        const run = yield* store.getRun(id);
        if (run === null) return null;
        yield* store.deleteQueuedRun(id);
        // A dispatch that got past its last check may have made the thread anyway.
        const turnState = yield* runtime.getTurnState(run.threadId);
        return { run, started: turnState !== CREW_TURN_STATE.MISSING };
      }),
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
              store.getRun(id).pipe(
                // A standing run starts no turn of its own, so it has none to recover.
                Effect.flatMap((run) =>
                  run === null || isStandingThread(run.threadId) ? Effect.void : replayPending(run),
                ),
              ),
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
