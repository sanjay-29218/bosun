// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { BotService } from "../bots/BotService.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { FeatureRuntimeLive } from "./runtimeLayer.ts";
import { FeatureService } from "./FeatureService.ts";
import { FeatureExecutionService } from "./FeatureExecutionService.ts";

const projectId = ProjectId.make("execution-project");
const now = "2026-09-30T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const runFile = NodeUtil.promisify(NodeChildProcess.execFile);
const git = (cwd: string, args: string[]) =>
  Effect.tryPromise({
    try: () => runFile("git", args, { cwd }).then((result) => result.stdout.trim()),
    catch: (cause) =>
      new GitCommandError({ operation: "test", command: "git", cwd, detail: String(cause) }),
  });

const withSystem = <E>(
  use: (
    directory: string,
    failSetup: () => void,
  ) => Effect.Effect<
    void,
    E,
    | FeatureExecutionService
    | FeatureService
    | BotService
    | OrchestrationEngineService
    | ProjectionSnapshotQuery
    | SqlClient.SqlClient
    | ThreadBackgroundLivenessService
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-execution-")).then((path) =>
        NodeFSP.realpath(path),
      ),
    );
    let setupFails = false;
    const gitLayer = Layer.mock(GitWorkflowService)({
      isRepository: (cwd) =>
        git(cwd, ["rev-parse", "--is-inside-work-tree"]).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      hasCommit: ({ cwd, refName }) =>
        git(cwd, ["rev-parse", "--verify", refName]).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      createWorktree: (input, options) =>
        Effect.gen(function* () {
          const path = NodePath.join(directory, "checkout");
          yield* git(input.cwd, ["worktree", "add", "-b", input.newRefName!, path, input.refName]);
          if (options?.progress?.onWorktreeClaimed) yield* options.progress.onWorktreeClaimed(path);
          return { worktree: { path, refName: input.newRefName! } };
        }),
      localStatus: ({ cwd }) =>
        git(cwd, ["branch", "--show-current"]).pipe(
          Effect.map((refName) => ({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName,
            hasWorkingTreeChanges: true,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          })),
        ),
    });
    const scripts = Layer.succeed(
      ProjectSetupScriptRunner,
      ProjectSetupScriptRunner.of({
        runForThread: () =>
          Effect.succeed(
            setupFails
              ? ((setupFails = false),
                {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "setup",
                  terminalId: "setup-terminal",
                  cwd: directory,
                  async: false,
                  completion: Effect.succeed({ exitCode: 1, durationMs: 1 }),
                })
              : { status: "no-script" as const },
          ),
      }),
    );
    const layer = FeatureRuntimeLive.pipe(
      Layer.provideMerge(OrchestrationLayerLive),
      Layer.provide(gitLayer),
      Layer.provide(scripts),
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "feature-execution-" })),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      yield* (yield* OrchestrationEngineService).dispatch({
        type: "project.create",
        commandId: CommandId.make("project-create"),
        projectId,
        title: "Execution tests",
        workspaceRoot: directory,
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      yield* (yield* BotService).ensureCrew(projectId, modelSelection);
      yield* use(directory, () => {
        setupFails = true;
      });
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

const createFeature = (id: string) =>
  Effect.flatMap(FeatureService, (features) =>
    features.create({
      id,
      projectId,
      title: "Feature result",
      brief: "Produce and review the requested result",
      actorId: "session-owner",
    }),
  );
const createThread = (id: string, path: string) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: ThreadId.make(id),
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: path,
      createdAt: now,
    }),
  );
const start = (id: string, key = id) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`start-${key}`),
      threadId: ThreadId.make(id),
      message: {
        messageId: MessageId.make(`message-${key}`),
        role: "user",
        text: "Work on this feature",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: now,
    }),
  );

describe("feature execution", () => {
  it.effect("recovers a failed setup in the same real Git checkout and preserves dirty work", () =>
    withSystem((directory, failSetup) =>
      Effect.gen(function* () {
        yield* git(directory, ["init"]);
        yield* git(directory, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "Initial",
        ]);
        yield* createFeature("coding");
        const execution = yield* FeatureExecutionService;
        failSetup();
        const failed = yield* execution
          .prepare({ featureId: "coding", projectId, mode: "worktree", actorId: "actor" })
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        const first = yield* execution.inspect("coding", projectId);
        expect(first?.checkout?.phase).toBe("failed");
        expect(first?.checkout?.setupThreadId).toBeTruthy();
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(first!.checkout!.path!, "user-work.txt"),
            "Keep my changes",
          ),
        );
        const ready = yield* execution.prepare({
          featureId: "coding",
          projectId,
          mode: "worktree",
          actorId: "actor",
        });
        expect(ready.path).toBe(first!.checkout!.path);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(ready.path!, "user-work.txt"), "utf8"),
          ),
        ).toBe("Keep my changes");
        expect(
          (yield* execution.prepare({
            featureId: "coding",
            projectId,
            mode: "worktree",
            actorId: "other",
          })).actorId,
        ).toBe("actor");
      }),
    ),
  );

  it.effect("supports non-Git work and bounds feature and artifact attribution", () =>
    withSystem((directory) =>
      Effect.gen(function* () {
        const feature = yield* createFeature("research");
        const execution = yield* FeatureExecutionService;
        expect(feature.ownerId).toBe("session-owner");
        const checkout = yield* execution.prepare({
          featureId: "research",
          projectId,
          mode: "workspace",
          actorId: "reader",
        });
        expect(checkout.path).toBe(directory);
        expect(checkout.branch).toBeNull();
        const report = {
          featureId: "research",
          projectId,
          id: "report",
          kind: "linear" as const,
          title: "Declined update",
          url: "https://linear.app/example/issue/BUS-21",
          status: "declined" as const,
          detail: "User declined the external update",
          actorId: "run-report",
        };
        const recorded = yield* execution.recordArtifact(report);
        expect(yield* execution.recordArtifact(report)).toEqual(recorded);
        expect(
          (yield* execution.recordArtifact({ ...report, actorId: "other" }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* execution
            .recordArtifact({ ...report, id: "bad-url", url: "javascript:alert(1)" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* execution
            .recordArtifact({ ...report, id: "wrong-thread", threadId: ThreadId.make("unrelated") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* execution.inspect("research", ProjectId.make("wrong-project"))).toBeNull();
        const inspection = yield* execution.inspect("research", projectId);
        expect(inspection?.artifacts).toEqual([recorded]);
        expect(inspection?.bots.every((bot) => bot.featureId === "research")).toBe(true);
        yield* (yield* FeatureService).setStatus("research", projectId, "closed");
        expect(
          (yield* execution
            .prepare({ featureId: "research", projectId, mode: "workspace", actorId: "reader" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );

  it.effect("fences competing writers until the provider and background work actually finish", () =>
    withSystem((directory) =>
      Effect.gen(function* () {
        yield* createFeature("writers");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO feature_checkouts(feature_id, project_id, mode, phase, project_cwd, path, actor_id, updated_at) VALUES ('writers', ${projectId}, 'worktree', 'ready', ${directory}, ${directory}, 'owner', ${now})`;
        yield* createThread("writer-one", directory);
        const alias = NodePath.join(directory, "checkout-alias");
        yield* Effect.promise(() => NodeFSP.symlink(directory, alias, "dir"));
        yield* createThread("writer-two", alias);
        const outcomes = yield* Effect.all(
          [start("writer-one").pipe(Effect.result), start("writer-two").pipe(Effect.result)],
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        const inspection = yield* (yield* FeatureExecutionService).inspect("writers", projectId);
        const owner = inspection!.writerThreadId!;
        const next = owner === "writer-one" ? "writer-two" : "writer-one";
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("interrupt"),
          threadId: owner,
          createdAt: now,
        });
        expect((yield* start(next, "after-interrupt").pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* engine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make("move-owner"),
              threadId: owner,
              worktreePath: null,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const turnId = TurnId.make(`turn-${owner}`);
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("session-running"),
          threadId: owner,
          session: {
            threadId: owner,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
        const background = yield* ThreadBackgroundLivenessService;
        background.recordTaskLiveness({
          threadId: owner,
          taskId: "child",
          taskType: undefined,
          status: "running",
          kind: "started",
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("server:provider-session-set:session-ready"),
          threadId: owner,
          session: {
            threadId: owner,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
        expect((yield* start(next, "after-parent").pipe(Effect.result))._tag).toBe("Failure");
        background.clearThreadLiveness(owner);
        yield* start(next, "after-child");
        expect(
          (yield* (yield* FeatureExecutionService).inspect("writers", projectId))?.writerThreadId,
        ).toBe(next);
        expect(
          (yield* (yield* FeatureService)
            .setStatus("writers", projectId, "closed")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );
});
