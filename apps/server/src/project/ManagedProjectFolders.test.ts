import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CAPTAIN_BOT_ID,
  CommandId,
  ProjectId,
  ThreadId,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";

const layerGitWorkflow = (vcsProcess?: Layer.Layer<VcsProcess.VcsProcess>) =>
  GitWorkflow.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(vcsProcess ?? VcsProcess.layer))),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const layerRealGit = GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer));

interface HarnessOptions {
  readonly vcsProcess?: Layer.Layer<VcsProcess.VcsProcess>;
  readonly git?: Layer.Layer<GitVcsDriver.GitVcsDriver>;
  readonly projects?: (
    real: ProjectService.ProjectService["Service"],
  ) => ProjectService.ProjectService["Service"];
}

const layer = (baseDir: string, options?: HarnessOptions) =>
  ManagedProjectFolders.layer.pipe(
    Layer.provide(
      options?.projects === undefined
        ? Layer.empty
        : Layer.effect(
            ProjectService.ProjectService,
            ProjectService.ProjectService.pipe(Effect.map(options.projects)),
          ),
    ),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(layerGitWorkflow(options?.vcsProcess)),
    Layer.provideMerge(options?.git ?? layerRealGit),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const withScratch = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | SqlClient.SqlClient
    | NodeServices.NodeServices
    | Scope.Scope
  >,
  options?: HarnessOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-managed-folders-" });
    return yield* body({ baseDir }).pipe(Effect.provide(layer(baseDir, options)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

const requireRoot = Effect.gen(function* () {
  const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
  return Option.getOrThrow(yield* scratch.scratchRoot);
});

it.effect("keeps Scratch outside the Git checkout the data dir sits in", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scratch-repo-" });
    yield* git(checkout, ["init", "--quiet"]);
    const baseDir = path.join(checkout, ".t3");
    yield* fileSystem.makeDirectory(baseDir);
    yield* Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const root = yield* requireRoot;
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(root, { recursive: true }).pipe(Effect.ignore),
      );
      assert.isTrue(path.relative(checkout, root).startsWith(".."));
      const botsRoot = Option.getOrThrow(yield* scratch.botHomesRoot);
      assert.isTrue(path.relative(checkout, botsRoot).startsWith(".."));
      assert.notEqual(botsRoot, root);
      const { projectId } = yield* scratch.ensureScratchProject;
      assert.isTrue(yield* scratch.isScratchProject(projectId));
      assert.isTrue(yield* fileSystem.exists(root));
    }).pipe(Effect.provide(layer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("offers a Scratch folder when Git is not installed", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        assert.equal(yield* requireRoot, path.resolve(baseDir, "scratch"));
      }),
    {
      vcsProcess: Layer.succeed(VcsProcess.VcsProcess, {
        run: (input) =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                syscall: `spawn ${input.command}`,
              }),
            }),
          ),
      }),
    },
  ),
);

it.effect("creates one Scratch project, even for concurrent first requests", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => scratch.ensureScratchProject),
        { concurrency: "unbounded" },
      );
      const again = yield* scratch.ensureScratchProject;
      assert.deepEqual(
        new Set(racers.map((result) => result.projectId)),
        new Set([again.projectId]),
      );

      const snapshot = yield* projects.snapshot;
      const root = yield* requireRoot;
      const scratchProjects = snapshot.projects.filter((project) => project.workspaceRoot === root);
      assert.lengthOf(scratchProjects, 1);
      assert.equal(scratchProjects[0]?.title, "No project");
      assert.deepEqual(scratchProjects[0]?.projectIcon, {
        kind: "lucide",
        name: "message-square-dashed",
        color: "gray",
      });
    }),
  ),
);

const insertBot = (id: string, name: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        INSERT INTO bots (
          id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode,
          model_selection_json, position, revision, created_at, updated_at
        ) VALUES (
          ${id}, ${name},
          '{"head":"round","eyes":"round","face":"visor","top":"ball","cheeks":false,"smile":false}',
          'blue', 'Coordinate.', '[]', 'approval-required', NULL, 1, 1, '2026-11-05', '2026-11-05'
        )
      `,
    ),
  );

it.effect("gives each bot one home, even for concurrent first requests, apart from Scratch", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* insertBot("bot:nepse", "NEPSE Desk");
      const root = Option.getOrThrow(yield* folders.botHomesRoot);
      assert.equal(root, path.resolve(baseDir, "bots"));

      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => folders.ensureBotHome({ id: "bot:nepse", name: "NEPSE" })),
        { concurrency: "unbounded" },
      );
      const again = yield* folders.ensureBotHome({ id: "bot:nepse", name: "NEPSE" });
      assert.deepEqual(new Set(racers.map((home) => home.projectId)), new Set([again.projectId]));
      assert.equal(path.dirname(again.workspaceRoot), root);
      assert.match(path.basename(again.workspaceRoot), /^bot-nepse@[0-9a-f]{16}$/);
      assert.equal(Option.getOrThrow(yield* folders.botHomePath("bot:nepse")), again.workspaceRoot);
      assert.isTrue(yield* fileSystem.exists(again.workspaceRoot));
      // A plain folder: no checkpoints or worktrees.
      assert.isFalse(yield* fileSystem.exists(path.join(again.workspaceRoot, ".git")));
      const project = Option.getOrThrow(yield* projects.getById(again.projectId));
      assert.equal(project.botId, "bot:nepse");
      assert.deepEqual(project.projectIcon, { kind: "lucide", name: "bot", color: "gray" });

      const captain = yield* folders.ensureBotHome({ id: CAPTAIN_BOT_ID, name: "Captain" });
      assert.equal(captain.workspaceRoot, path.join(root, CAPTAIN_BOT_ID));
      // An ID that is already a plain folder name never shares a home with an encoded one.
      yield* insertBot("bot-nepse-06258b94", "Lookalike");
      const lookalike = yield* folders.ensureBotHome({
        id: "bot-nepse-06258b94",
        name: "Lookalike",
      });
      assert.equal(lookalike.workspaceRoot, path.join(root, "bot-nepse-06258b94"));
      assert.notEqual(lookalike.workspaceRoot, again.workspaceRoot);
      assert.notEqual(lookalike.projectId, again.projectId);
      // Folder names that a case-insensitive or Windows filesystem would merge or refuse get a
      // hash too.
      const homeOf = (id: string) =>
        insertBot(id, id).pipe(Effect.andThen(folders.ensureBotHome({ id, name: id })));
      const lower = yield* homeOf("bot-nepse");
      assert.equal(lower.workspaceRoot, path.join(root, "bot-nepse"));
      for (const id of ["BOT-NEPSE", "CON", "nul", "bot.", "bot. "]) {
        const home = yield* homeOf(id);
        assert.match(path.basename(home.workspaceRoot), /@[0-9a-f]{16}$/, id);
        assert.notEqual(home.workspaceRoot.toLowerCase(), lower.workspaceRoot.toLowerCase());
      }
      // A project another bot owns at a bot's home path is never taken over.
      yield* insertBot("bot-squatted", "Squatted");
      const squattedRoot = path.join(root, "bot-squatted");
      yield* fileSystem.makeDirectory(squattedRoot, { recursive: true });
      yield* projects.create({
        commandId: CommandId.make("squatter"),
        projectId: ProjectId.make("squatter"),
        title: "Squatter",
        workspaceRoot: squattedRoot,
      });
      const refused = yield* folders
        .ensureBotHome({ id: "bot-squatted", name: "Squatted" })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "BotHomeError");
      const scratch = yield* folders.ensureScratchProject;
      const plain = yield* projects.create({
        commandId: CommandId.make("plain-project"),
        projectId: ProjectId.make("plain-project"),
        title: "Plain",
        workspaceRoot: baseDir,
      });
      assert.deepEqual(
        yield* Effect.forEach(
          [again.projectId, captain.projectId, scratch.projectId, plain.id],
          (projectId) =>
            Effect.all([folders.isBotHome(projectId), folders.isHiddenProject(projectId)]),
        ),
        [
          [true, true],
          [true, true],
          [false, true],
          [false, false],
        ],
      );
    }),
  ),
);

it.effect("recreates the Scratch folder after it is deleted", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      yield* fileSystem.remove(root, { recursive: true });

      assert.equal((yield* scratch.ensureScratchProject).projectId, projectId);
      assert.isTrue(yield* fileSystem.exists(root));

      yield* fileSystem.remove(root, { recursive: true });
      const folder = yield* scratch.folderForThread({
        projectId,
        threadId: ThreadId.make("thread-after-delete"),
        text: "Still works",
      });
      assert.isTrue(yield* fileSystem.exists(Option.getOrThrow(folder)));
    }),
  ),
);

it.effect("gives each Scratch thread its own folder, named from its message", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { projectId } = yield* scratch.ensureScratchProject;
      const root = yield* requireRoot;
      const text = "Convert these PNGs to WebP, please!";
      const first = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:a:0123456789abcdef"),
          text,
        }),
      );
      const second = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b:0123456789abcdef"),
          text,
        }),
      );

      const third = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread:b0123456789abcdef"),
          text,
        }),
      );

      assert.equal(new Set([first, second, third]).size, 3);
      for (const folder of [first, second, third]) {
        assert.equal(path.dirname(folder), root);
        assert.match(path.basename(folder), /^\d{4}-\d{2}-\d{2}-convert-these-pngs-to-webp-/);
        assert.isTrue(yield* fileSystem.exists(folder));
      }

      const pasted = Option.getOrThrow(
        yield* scratch.folderForThread({
          projectId,
          threadId: ThreadId.make("thread-pasted"),
          text: `${"word ".repeat(10_000)}../../etc`,
        }),
      );
      assert.equal(path.dirname(pasted), root);
      assert.isAtMost(path.basename(pasted).length, 80);
    }),
  ),
);

it.effect("leaves threads in other projects alone", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { projectId: scratchId } = yield* scratch.ensureScratchProject;
      const other = yield* projects.create({
        commandId: CommandId.make("command:other"),
        projectId: ProjectId.make("project:other"),
        title: "Other",
        workspaceRoot: path.join(baseDir, "other"),
        createWorkspaceRootIfMissing: true,
      });

      const folder = yield* scratch.folderForThread({
        projectId: other.id,
        threadId: ThreadId.make("thread-other"),
        text: "Hello",
      });
      assert.isTrue(Option.isNone(folder));
      assert.deepEqual(yield* fileSystem.readDirectory(yield* requireRoot), []);
      assert.isTrue(yield* scratch.isScratchProject(scratchId));
      assert.isFalse(yield* scratch.isScratchProject(other.id));
    }),
  ),
);

const GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

const withGitEnv = <A, E, R>(
  env: Partial<Record<(typeof GIT_IDENTITY_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const emptyConfig = yield* fileSystem.makeTempFileScoped({ prefix: "t3-gitconfig-" });
    const hostEnv: NodeJS.ProcessEnv = { ...(yield* HostProcess.Environment) };
    for (const key of GIT_IDENTITY_KEYS) delete hostEnv[key];
    return yield* effect.pipe(
      Effect.provideService(HostProcess.Environment, {
        ...hostEnv,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      }),
    );
  });

const TEST_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

it.effect("starts a named project as a committed repository, and suffixes a taken name", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.resolve(baseDir, "projects");
        assert.equal(folders.namedProjectsRoot, root);
        const attributes = path.join(baseDir, "crlf.gitattributes");
        const crlfConfig = path.join(baseDir, "crlf.gitconfig");
        yield* fileSystem.writeFileString(attributes, "* text=auto eol=crlf\n");
        yield* git(baseDir, ["config", "--file", crlfConfig, "core.safecrlf", "true"]);
        yield* git(baseDir, ["config", "--file", crlfConfig, "core.attributesFile", attributes]);
        (yield* HostProcess.Environment).GIT_CONFIG_GLOBAL = crlfConfig;

        const first = yield* folders.createNamedProject({ name: "Pinball Stats" });
        const second = yield* folders.createNamedProject({ name: "pinball stats" });

        assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
        assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
        assert.isUndefined(first.commitError);
        const project = Option.getOrThrow(yield* projects.getById(first.projectId));
        assert.equal(project.title, "Pinball Stats");
        assert.equal(project.workspaceRoot, first.workspaceRoot);

        const readme = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "README.md"),
        );
        assert.include(readme, "# Pinball Stats");
        assert.include(readme, `src="assets/icon.svg"`);
        const icon = yield* fileSystem.readFileString(
          path.join(first.workspaceRoot, "assets", "icon.svg"),
        );
        assert.include(icon, ">PS</text>");
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["log", "--format=%s"]),
          "Initial commit",
        );
        assert.equal(
          yield* gitOutput(first.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "main",
        );
        assert.equal(yield* gitOutput(first.workspaceRoot, ["status", "--porcelain"]), "");
      }),
    ),
  ),
);

it.effect("gives concurrent named projects with the same name distinct folders", () =>
  withScratch(() =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const created = yield* Effect.all(
          Array.from({ length: 4 }, () => folders.createNamedProject({ name: "Race" })),
          { concurrency: "unbounded" },
        );

        assert.equal(new Set(created.map((result) => result.workspaceRoot)).size, 4);
        assert.equal(new Set(created.map((result) => result.projectId)).size, 4);
        const snapshot = yield* projects.snapshot;
        for (const result of created) {
          assert.isTrue(
            snapshot.projects.some((project) => project.workspaceRoot === result.workspaceRoot),
          );
        }
      }),
    ),
  ),
);

it.effect("keeps a named project and reports why when Git cannot commit", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      {},
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(baseDir, "no-identity.gitconfig"),
          "[user]\n\tuseConfigOnly = true\n",
        );
        (yield* HostProcess.Environment).GIT_CONFIG_GLOBAL = path.join(
          baseDir,
          "no-identity.gitconfig",
        );

        const result = yield* folders.createNamedProject({ name: "No Identity" });

        assert.include(result.commitError ?? "", "no name or email");
        assert.isTrue(Option.isSome(yield* projects.getById(result.projectId)));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, "README.md")));
        assert.isTrue(yield* fileSystem.exists(path.join(result.workspaceRoot, ".git")));
      }),
    ),
  ),
);

it.effect("keeps a folder that another project owns when the create conflicts", () =>
  withScratch(({ baseDir }) =>
    withGitEnv(
      TEST_IDENTITY,
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const taken = path.join(folders.namedProjectsRoot, "taken");
        yield* projects.create({
          commandId: CommandId.make("command:owner"),
          projectId: ProjectId.make("project:owner"),
          title: "Owner",
          workspaceRoot: taken,
          createWorkspaceRootIfMissing: true,
        });
        yield* fileSystem.remove(taken, { recursive: true });

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Taken" }));

        assert.equal(failure._tag, "NamedProjectCreateError");
        assert.equal(failure.message, "Failed to create the project.");
        assert.isTrue(yield* fileSystem.exists(path.join(taken, "README.md")));
        const owner = yield* projects.getByWorkspaceRoot(taken);
        assert.equal(Option.getOrThrow(owner).id, ProjectId.make("project:owner"));
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
          "taken",
        ]);
      }),
    ),
  ),
);

it.effect("removes the folder when the project create is rejected for another reason", () =>
  withScratch(
    ({ baseDir }) =>
      withGitEnv(
        TEST_IDENTITY,
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const failure = yield* Effect.flip(folders.createNamedProject({ name: "Rejected" }));

          assert.equal(failure._tag, "NamedProjectCreateError");
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
        }),
      ),
    {
      projects: (real) =>
        ProjectService.ProjectService.of({
          ...real,
          create: (input) =>
            Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "dispatch-project-command",
                projectId: input.projectId,
                cause: "store unavailable",
              }),
            ),
        }),
    },
  ),
);

it.effect("removes the folder when the create is cancelled before the project exists", () =>
  Effect.gen(function* () {
    const scaffolding = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const fiber = yield* folders
            .createNamedProject({ name: "Cancelled" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(scaffolding);
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
            "cancelled",
          ]);
          yield* Fiber.interrupt(fiber);

          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
          assert.deepEqual((yield* projects.snapshot).projects, []);
        }),
      {
        git: Layer.mock(GitVcsDriver.GitVcsDriver)({
          readConfigValue: () => Effect.succeed(null),
          execute: () =>
            Deferred.succeed(scaffolding, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      },
    );
  }),
);
