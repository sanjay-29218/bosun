import {
  botHeadquartersRunId,
  botHeadquartersThreadId,
  CREW_DISPATCH_STATE,
  CREW_TURN_STATE,
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  ThreadId,
  type CrewTurnState,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { OrchestratorV2Error as OrchestrationDispatchError } from "../orchestration-v2/Orchestrator.ts";
import type { PersistenceSqlError, ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  CrewStore,
  type CrewMember,
  type CrewDelegationGrant,
  type CrewHierarchyNode,
  type Role,
  type CrewRun,
  type CrewRunSummary,
} from "./CrewStore.ts";
import * as BotStore from "../bots/BotStore.ts";
import { CrewThreadRuntime } from "./CrewThreadRuntime.ts";

export class CrewValidationError extends Error {
  readonly _tag = "CrewValidationError";
}

/*
 * Member IDs below predate the Roles rename. They stay as they are because stored runs,
 * handoffs, grants and feature bindings reference them.
 */
/** The member made from the project manager role for one project, created on first use. */
export const projectManagerMemberId = (projectId: ProjectId) => `bot-manager:${projectId}`;
/** The project whose manager `memberId` names, so a bot can reach one before it exists. */
export const managedProjectId = (memberId: string) =>
  memberId.startsWith("bot-manager:")
    ? ProjectId.make(memberId.slice("bot-manager:".length))
    : null;
/** The builder a project manager hands direct requests to, created with the manager. */
export const projectBuilderMemberId = (projectId: ProjectId) => `bot-builder:${projectId}`;
export const BUILDER_ROLE_ID = "role:builder";

const HEADQUARTERS_TASK = [
  "You run this bot's work across every project it owns. crew_list_projects shows them with each project's manager and features. Hand project work to a project's manager with crew_delegate, and start a new project with crew_create_project when you're allowed to.",
  "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.",
  "Tell the person only what they must decide.",
].join("\n\n");

const STAGE_TOOLS = ["crew.respond", "crew.ask"];
const stageInstructions = (name: string) =>
  `You are the ${name}. Follow the assigned task in the linked T3 thread. Call crew_respond with a structured outcome and a concise summary when finished. If information is missing, call crew_ask with the exact question, then continue after an answer. Do not report completion solely in prose.`;

/** Roles `ensureDefaults` creates when they are missing. People can edit or add more. */
const DEFAULT_ROLES = [
  {
    id: PROJECT_MANAGER_ROLE_ID,
    name: "Project manager",
    autoCreateForFeature: false,
    allowedTools: ["crew.delegate", "crew.respond", "crew.ask", "crew.status", "crew.answer"],
    instructions:
      "You manage one project. Delegate implementation to the project's builder using crew_delegate and a stable request ID. Use crew_wait_handoff for its structured outcome. Report the outcome to whoever asked through crew_respond. If the builder needs a person's answer, use crew_ask; when the answer arrives, pass it to the child request using crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.",
  },
  { id: "role:planner", name: "Planner" },
  { id: "role:designer", name: "Designer" },
  { id: BUILDER_ROLE_ID, name: "Builder" },
  { id: "role:qa-tester", name: "QA Tester" },
  { id: "role:reviewer", name: "Reviewer" },
].map((role) => ({
  autoCreateForFeature: true,
  // Stage roles report their outcome through crew_respond; without it a workflow can't start.
  allowedTools: STAGE_TOOLS,
  instructions: stageInstructions(role.name),
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
  readonly autoCreateForFeature?: boolean;
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
  /** The thread's title; defaults to the member's name and the start of the task. */
  readonly title?: string;
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
   * The project's manager, made from the project manager role on first use together with the
   * builder it delegates to. Captain may delegate to it.
   */
  readonly ensureProjectManager: (
    projectId: ProjectId,
  ) => Effect.Effect<CrewMember, CrewServiceError>;
  /** A person's request to the project's bot, which hands it to the project's manager. */
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
  readonly getRun: (
    id: string,
  ) => Effect.Effect<CrewRunView | null, PersistenceSqlError | ProjectionRepositoryError>;
  readonly listRunSummaries: (
    projectId: ProjectId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<CrewRunSummary>, PersistenceSqlError>;
  readonly reconcileRuns: () => Effect.Effect<void, PersistenceSqlError>;
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
      prompt: `${run.instructions}\n\nTask:\n${run.taskText}`,
      modelSelection: run.modelSelection,
      runtimeMode: run.runtimeMode,
      createdAt: run.createdAt,
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

    const createMember: CrewServiceShape["createMember"] = (input) =>
      Effect.gen(function* () {
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
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertMember(member);
        return member;
      });

    /** Creates `input` unless a member with its ID exists, which must match its scope. */
    const ensureMember = (input: CreateCrewMemberInput) =>
      Effect.gen(function* () {
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
            store
              .getMember(input.id)
              .pipe(
                Effect.flatMap((persisted) =>
                  persisted?.projectId === input.projectId
                    ? Effect.succeed(persisted)
                    : Effect.fail(error),
                ),
              ),
          ),
        );
        return { member, created: true };
      });

    const createRole: CrewServiceShape["createRole"] = (input) =>
      Effect.gen(function* () {
        const id = yield* Effect.try({
          try: () => nonEmpty(input.id, "Role ID", 128),
          catch: () => new CrewValidationError("Invalid role ID"),
        });
        const name = yield* Effect.try({
          try: () => nonEmpty(input.name, "Role name", 200),
          catch: () => new CrewValidationError("Invalid role name"),
        });
        const instructions = yield* Effect.try({
          try: () => nonEmpty(input.instructions, "Role instructions", 16_000),
          catch: () => new CrewValidationError("Invalid role instructions"),
        });
        const allowedTools = yield* Effect.try({
          try: () => validTools(input.allowedTools),
          catch: () => new CrewValidationError("Invalid tool grants"),
        });
        const now = DateTime.formatIso(yield* DateTime.now);
        const role: Role = {
          ...input,
          id,
          name,
          instructions,
          allowedTools,
          autoCreateForFeature: input.autoCreateForFeature ?? false,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        yield* store.insertRole(role);
        return role;
      });

    const updateRole: CrewServiceShape["updateRole"] = (input) =>
      Effect.gen(function* () {
        const previous = yield* store.getRole(input.id);
        if (
          !previous ||
          previous.revision !== input.expectedRevision ||
          !Number.isSafeInteger(input.expectedRevision)
        ) {
          return yield* Effect.fail(new CrewValidationError("Role changed or is unavailable"));
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
          try: () => validTools(input.allowedTools),
          catch: () => new CrewValidationError("Invalid tool grants"),
        });
        const updated: Role = {
          ...previous,
          name,
          instructions,
          allowedTools,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          enabled: input.enabled,
          autoCreateForFeature: input.autoCreateForFeature ?? false,
          revision: previous.revision + 1,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (!(yield* store.updateRole(updated, previous.revision))) {
          return yield* Effect.fail(new CrewValidationError("Role changed; reload and retry"));
        }
        return updated;
      });

    /** A member of `roleId` for the project, carrying the role's configuration. */
    const projectMemberFromRole = (
      id: string,
      projectId: ProjectId,
      roleId: string,
      context: string,
    ) =>
      Effect.gen(function* () {
        // An existing member keeps working even if its role was turned off since.
        const existing = yield* store.getMember(id);
        if (existing?.projectId === projectId) return { member: existing, created: false };
        const role = yield* store.getRole(roleId);
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
          instructions: `${role.instructions}\n\n${context}`,
          allowedTools: role.allowedTools,
          modelSelection: role.modelSelection,
          runtimeMode: role.runtimeMode,
        });
      });

    const ensureProjectManager: CrewServiceShape["ensureProjectManager"] = (projectId) =>
      Effect.gen(function* () {
        if (!(yield* runtime.projectExists(projectId))) {
          return yield* Effect.fail(new CrewValidationError("Project does not exist"));
        }
        const managerId = projectManagerMemberId(projectId);
        const builderId = projectBuilderMemberId(projectId);
        // Each part is ensured on every call, so a setup interrupted half way (or stopped by a
        // disabled role) is completed by the next request once the role is back.
        const manager = yield* projectMemberFromRole(
          managerId,
          projectId,
          PROJECT_MANAGER_ROLE_ID,
          `You manage project ${projectId}. Its builder is crew member ${builderId}.`,
        );
        const builder = yield* projectMemberFromRole(
          builderId,
          projectId,
          BUILDER_ROLE_ID,
          `You work on project ${projectId}.`,
        );
        // The project's bot may delegate to the manager because it owns the project.
        yield* store.grantDelegation(managerId, builderId);
        if (builder.created) yield* store.setParent(builderId, managerId, 0);
        return manager.member;
      });

    /**
     * Who acts in a new run: a crew member on the run's project (or an environment-wide one),
     * or the top-level bot that owns the project.
     */
    const runActor = (id: string, projectId: ProjectId) =>
      Effect.gen(function* () {
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

    const createRun: CrewServiceShape["createRun"] = (input) =>
      Effect.gen(function* () {
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
          modelSelection: yield* modelFor(member, input.modelSelection),
          runtimeMode: member.runtimeMode,
          dispatchState: CREW_DISPATCH_STATE.QUEUED,
          recoveryAttempt: 0,
          lastError: null,
          createdAt,
          dispatchedAt: null,
        };
        yield* store.insertRun(run);
        const persisted = yield* store.getRun(id);
        if (persisted === null || !sameRunRequest(persisted, request)) {
          return yield* Effect.fail(new CrewValidationError("Run ID belongs to another request"));
        }
        if (persisted.dispatchState === CREW_DISPATCH_STATE.QUEUED) yield* dispatch(persisted);
        return (yield* store.getRun(id))!;
      });

    // One at a time, so two opens of a deleted headquarters restore it once.
    const headquartersLock = yield* Semaphore.make(1);
    const ensureHeadquarters: CrewServiceShape["ensureHeadquarters"] = (botId, fallbackProjectId) =>
      Effect.gen(function* () {
        const id = botHeadquartersRunId(botId);
        const bot = yield* bots.get(botId);
        if (bot === null) return yield* Effect.fail(new CrewValidationError("Bot not found"));
        // The run keeps its last model for decoding, so a bot without one is refused here.
        const modelSelection = yield* modelFor(bot, undefined);
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
        const existing = yield* store.getRun(id);
        // A headquarters whose project was deleted moves, and `restore` restarts it there.
        if (existing !== null && !(yield* runtime.projectExists(existing.projectId))) {
          yield* store.moveRun(id, yield* home);
        }
        if (existing === null) {
          const projectId = yield* home;
          yield* store.insertRun({
            id,
            memberId: bot.id,
            projectId,
            threadId: botHeadquartersThreadId(bot.id),
            taskText: HEADQUARTERS_TASK,
            title: bot.name,
            instructions: bot.instructions,
            allowedTools: bot.allowedTools,
            memberRevision: bot.revision,
            modelSelection,
            runtimeMode: bot.runtimeMode,
            dispatchState: CREW_DISPATCH_STATE.QUEUED,
            recoveryAttempt: 0,
            lastError: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            dispatchedAt: null,
          });
        }
        const run = (yield* store.getRun(id))!;
        if (run.dispatchState === CREW_DISPATCH_STATE.QUEUED) {
          yield* dispatch(run);
        } else {
          // A deleted thread restarts with the bot's instructions as they are now.
          yield* runtime.restore({
            ...threadInput(run),
            prompt: `${bot.instructions}\n\nTask:\n${run.taskText}`,
          });
          yield* runtime.syncSettings(run.threadId, bot.runtimeMode, modelSelection);
        }
        yield* runtime
          .pin(run.threadId, `${id}:pin`)
          .pipe(
            Effect.catch((error) => Effect.logWarning("Headquarters pin failed", { id, error })),
          );
        return (yield* store.getRun(id))!;
      }).pipe(headquartersLock.withPermits(1));

    const syncHeadquarters: CrewServiceShape["syncHeadquarters"] = (botId) =>
      Effect.gen(function* () {
        const bot = yield* bots.get(botId);
        const run = yield* store.getRun(botHeadquartersRunId(botId));
        if (!bot?.modelSelection || run?.dispatchState !== CREW_DISPATCH_STATE.STARTED) return;
        yield* runtime.syncSettings(run.threadId, bot.runtimeMode, bot.modelSelection);
      });

    const setHierarchyParent: CrewServiceShape["setHierarchyParent"] = (
      memberId,
      parentMemberId,
      position = 0,
    ) =>
      Effect.gen(function* () {
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

    const allowDelegation: CrewServiceShape["allowDelegation"] = (sourceMemberId, targetMemberId) =>
      Effect.gen(function* () {
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

    return {
      ensureDefaults: (modelSelection) =>
        Effect.gen(function* () {
          for (const role of DEFAULT_ROLES) {
            if (yield* store.getRole(role.id)) continue;
            yield* createRole({ ...role, modelSelection, runtimeMode: "approval-required" }).pipe(
              Effect.catch((error) =>
                store
                  .getRole(role.id)
                  .pipe(
                    Effect.flatMap((persisted) =>
                      persisted ? Effect.succeed(persisted) : Effect.fail(error),
                    ),
                  ),
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
      ensureProjectManager,
      startRequest: (input) =>
        Effect.gen(function* () {
          const existing = yield* store.getRun(input.id);
          // A retry of an accepted request must not depend on today's crew or owner.
          if (existing === null) yield* ensureProjectManager(input.projectId);
          const memberId = existing?.memberId ?? (yield* bots.projectOwner(input.projectId));
          if (memberId === null) {
            return yield* Effect.fail(new CrewValidationError("Project does not exist"));
          }
          return yield* createRun({
            id: input.id,
            memberId,
            projectId: input.projectId,
            taskText: `Project: ${input.projectId}. Project manager: ${projectManagerMemberId(input.projectId)}. Person's request: ${input.taskText}`,
            modelSelection: input.modelSelection,
          });
        }),
      createMember,
      createRole,
      updateRole,
      getMember: store.getMember,
      getRole: store.getRole,
      listRoles: store.listRoles,
      instantiate: (id, projectId, roleId) =>
        Effect.gen(function* () {
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
      projectConfiguration: (projectId) =>
        Effect.gen(function* () {
          if (!(yield* runtime.projectExists(projectId))) {
            return yield* Effect.fail(new CrewValidationError("Project not found"));
          }
          const [hierarchy, delegationGrants] = yield* Effect.all([
            store.listHierarchyForProject(projectId),
            store.listDelegationGrantsForProject(projectId),
          ]);
          return { hierarchy, delegationGrants };
        }),
      placeInProject: (input) =>
        Effect.gen(function* () {
          const child = yield* store.getMember(input.memberId);
          if (child?.projectId !== input.projectId) {
            return yield* Effect.fail(new CrewValidationError("Crew member not found in project"));
          }
          yield* setHierarchyParent(input.memberId, input.parentMemberId, input.position);
        }),
      setDelegationInProject: (input) =>
        Effect.gen(function* () {
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
      listRunSummaries: (projectId, limit = 50) =>
        store.listRunSummaries(projectId, Math.max(1, Math.min(100, Math.floor(limit)))),
      reconcileRuns: () =>
        Effect.gen(function* () {
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
    } satisfies CrewServiceShape;
  }),
);
