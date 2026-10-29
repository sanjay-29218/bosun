/**
 * BotProjects - a bot's view of the projects it owns, for its headquarters, the new projects it
 * starts, and the features it starts in them.
 *
 * @module BotProjects
 */
import {
  CAPTAIN_BOT_ID,
  CommandId,
  ProjectId,
  type FeatureCardState,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { projectManagerMemberId } from "../crew/CrewService.ts";
import { FeatureService } from "../features/FeatureService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import * as BotStore from "./BotStore.ts";

export class BotProjectsError extends Schema.TaggedError<BotProjectsError>()("BotProjectsError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface BotProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  /** Delegate to this member to hand the project work; it is created on first delegation. */
  readonly projectManagerId: string;
  readonly features: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly state: FeatureCardState;
    /** The current stage, such as "build"; null before the feature starts. */
    readonly stage: string | null;
  }>;
}

/** A feature a bot started, and where to follow it. */
export interface BotFeatureStart {
  readonly featureId: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly state: FeatureCardState | null;
  /** The current stage, such as "build". */
  readonly stage: string | null;
  /** The current stage's thread; null while the stage waits for an agent slot. */
  readonly threadId: ThreadId | null;
}

export class BotProjects extends Context.Service<
  BotProjects,
  {
    /** The projects `botId` owns, with their managers and features, leaving out Scratch. */
    readonly list: (botId: string) => Effect.Effect<ReadonlyArray<BotProject>, BotProjectsError>;
    /**
     * Starts a project `botId` owns: a fresh Git repository from `name`, or a clone of
     * `repositoryUrl`. Both land in the folder for projects started from a name.
     */
    readonly create: (input: {
      readonly botId: string;
      readonly name: string;
      readonly repositoryUrl?: string | undefined;
    }) => Effect.Effect<BotProject & { readonly commitError?: string }, BotProjectsError>;
    /**
     * Creates a feature in a project `botId` owns and starts it, as a person does from the
     * composer: on `workflowId`, or else Quick task, which is how a bot hands a project work.
     * A retry with the same `featureId` returns the same feature.
     */
    readonly startFeature: (input: {
      readonly botId: string;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly brief: string;
      readonly workflowId?: string | undefined;
      readonly featureId?: string | undefined;
    }) => Effect.Effect<BotFeatureStart, BotProjectsError>;
  }
>()("t3/bots/BotProjects") {}

const failWith = (reason: string) => () => new BotProjectsError({ reason });

export const layer = Layer.effect(
  BotProjects,
  Effect.gen(function* () {
    const bots = yield* BotStore.BotStore;
    const features = yield* FeatureService;
    const workflows = yield* WorkflowService;
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const projects = yield* ProjectService.ProjectService;
    const repositories = yield* Repositories.SourceControlRepositoryService;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const describe = (project: Project) =>
      features.board(project.id).pipe(
        Effect.mapError(failWith("Features are unavailable")),
        Effect.map((cards): BotProject => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          projectManagerId: projectManagerMemberId(project.id),
          features: cards.map((card) => ({
            id: card.featureId,
            title: card.title,
            state: card.state,
            stage: card.stage?.stepId ?? null,
          })),
        })),
      );

    const requireBot = (botId: string) =>
      bots.get(botId).pipe(
        Effect.mapError(failWith("Bots are unavailable")),
        Effect.filterOrFail(
          Predicate.isNotNull,
          () => new BotProjectsError({ reason: "Bot not found" }),
        ),
      );

    const readProject = (projectId: ProjectId) =>
      projects.getById(projectId).pipe(
        Effect.mapError(failWith("Projects are unavailable")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new BotProjectsError({ reason: "Project not found" })),
            onSome: Effect.succeed,
          }),
        ),
      );

    return BotProjects.of({
      list: Effect.fn("BotProjects.list")(function* (botId) {
        yield* requireBot(botId);
        const snapshot = yield* projects.snapshot.pipe(
          Effect.mapError(failWith("Projects are unavailable")),
        );
        const scratch = Option.getOrNull(yield* folders.scratchRoot);
        const owned = snapshot.projects.filter(
          (project) =>
            project.deletedAt === null &&
            (project.botId ?? CAPTAIN_BOT_ID) === botId &&
            project.workspaceRoot !== scratch,
        );
        return yield* Effect.forEach(owned, describe);
      }),
      create: Effect.fn("BotProjects.create")(function* ({ botId, name, repositoryUrl }) {
        yield* requireBot(botId);
        const title = name.trim();
        if (title.length === 0 || title.length > 200) {
          return yield* new BotProjectsError({ reason: "Name the project in 1-200 characters" });
        }
        if (repositoryUrl === undefined) {
          const created = yield* folders
            .createNamedProject({ name: title, botId })
            .pipe(Effect.mapError((error) => new BotProjectsError({ reason: error.message })));
          const project = yield* describe(yield* readProject(created.projectId));
          return created.commitError === undefined
            ? project
            : { ...project, commitError: created.commitError };
        }
        // Like a named project: the first free `<slug>`, `<slug>-2`, ... folder.
        const slug = newProjectFolderName(title);
        let destinationPath = path.join(folders.namedProjectsRoot, slug);
        for (
          let suffix = 2;
          yield* fileSystem
            .exists(destinationPath)
            .pipe(Effect.mapError(failWith("The projects folder is unreadable")));
          suffix++
        ) {
          destinationPath = path.join(folders.namedProjectsRoot, `${slug}-${suffix}`);
        }
        const cloned = yield* repositories
          .cloneRepository({ remoteUrl: repositoryUrl, destinationPath })
          .pipe(Effect.mapError((error) => new BotProjectsError({ reason: error.detail })));
        const id = yield* crypto.randomUUIDv4().pipe(Effect.mapError(failWith("No project id")));
        // The clone is only ours until the project exists, so a failed create removes it.
        const project = yield* projects
          .create({
            commandId: CommandId.make(`bot-project-clone:${id}`),
            projectId: ProjectId.make(id),
            title,
            workspaceRoot: cloned.cwd,
            botId,
          })
          .pipe(
            Effect.tapError(() => repositories.discardClone(cloned.cwd).pipe(Effect.ignore)),
            Effect.mapError(failWith("The clone worked, but the project wasn't created")),
          );
        return yield* describe(project);
      }),
      startFeature: Effect.fn("BotProjects.startFeature")(function* (input) {
        const bot = yield* requireBot(input.botId);
        const owner = yield* bots
          .projectOwner(input.projectId)
          .pipe(Effect.mapError(failWith("Projects are unavailable")));
        // Like `list`, this leaves out Scratch, where the headquarters lives.
        if (owner !== bot.id || (yield* folders.isScratchProject(input.projectId))) {
          return yield* new BotProjectsError({
            reason: `${bot.name} doesn't own project ${input.projectId}`,
          });
        }
        const workflowId =
          input.workflowId ??
          (yield* workflows.ensureQuickTaskDefinition().pipe(
            Effect.map((definition) => definition.id),
            Effect.mapError(failWith("The Quick task workflow is unavailable")),
          ));
        const id =
          input.featureId ??
          `feature:${yield* crypto.randomUUIDv4().pipe(Effect.mapError(failWith("No feature id")))}`;
        const feature = yield* features
          .create({
            id,
            projectId: input.projectId,
            title: input.title.trim(),
            brief: input.brief.trim(),
            workflowId,
          })
          .pipe(Effect.mapError((error) => new BotProjectsError({ reason: error.message })));
        const snapshot = yield* features.start(id, input.projectId).pipe(
          Effect.mapError(
            (error) =>
              new BotProjectsError({
                reason: `Feature ${id} was created but didn't start: ${error.message}`,
              }),
          ),
        );
        return {
          featureId: feature.id,
          projectId: feature.projectId,
          title: feature.title,
          workflowId,
          workflowRevision: snapshot.definition.revision,
          state: snapshot.state ?? null,
          stage: snapshot.activeStepId,
          threadId:
            snapshot.steps.find((step) => step.id === snapshot.activeStepId)?.threadId ?? null,
        };
      }),
    });
  }),
);
