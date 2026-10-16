/**
 * BotProjects - a bot's view of the projects it owns, for its headquarters, and the new
 * projects it starts.
 *
 * @module BotProjects
 */
import {
  CAPTAIN_BOT_ID,
  CommandId,
  ProjectId,
  type FeatureCardState,
  type Project,
} from "@t3tools/contracts";
import { newProjectFolderName } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
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
  }
>()("t3/bots/BotProjects") {}

const failWith = (reason: string) => () => new BotProjectsError({ reason });

export const layer = Layer.effect(
  BotProjects,
  Effect.gen(function* () {
    const bots = yield* BotStore.BotStore;
    const features = yield* FeatureService;
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
        Effect.flatMap((bot) =>
          bot
            ? Effect.succeed(bot)
            : Effect.fail(new BotProjectsError({ reason: "Bot not found" })),
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
      list: (botId) =>
        Effect.gen(function* () {
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
      create: ({ botId, name, repositoryUrl }) =>
        Effect.gen(function* () {
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
    });
  }),
);
