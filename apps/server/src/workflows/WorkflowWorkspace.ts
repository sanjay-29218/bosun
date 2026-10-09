import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface StageWorkspace {
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly commit: string | null;
  /** The requested paths that exist in `cwd`. */
  readonly existing: ReadonlySet<string>;
}

/** Everything a stage thread changed: its baseline checkpoint to its last completed turn. */
export interface StageThreadDiff {
  readonly turnCount: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly additions: number;
  readonly deletions: number;
  readonly fileCount: number;
}

/**
 * Reads the stage workspace for handoffs. Both reads are best effort: a project
 * outside git, or a thread without checkpoints, yields nulls instead of failing.
 */
export class WorkflowWorkspace extends Context.Service<
  WorkflowWorkspace,
  {
    readonly describe: (
      projectId: ProjectId,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<StageWorkspace>;
    readonly threadDiff: (threadId: ThreadId) => Effect.Effect<StageThreadDiff | null>;
  }
>()("t3/workflows/WorkflowWorkspace") {}

const empty: StageWorkspace = { cwd: null, branch: null, commit: null, existing: new Set() };

export const WorkflowWorkspaceLive = Layer.effect(
  WorkflowWorkspace,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const engine = yield* OrchestratorV2;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Crypto.Crypto;
    // Checkpoint refs never move, so a range's stats never change.
    const diffStats = new Map<string, Omit<StageThreadDiff, "turnCount">>();

    const describe = (projectId: ProjectId, paths: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const project = yield* projects.get(projectId);
        if (Option.isNone(project)) return empty;
        const cwd = project.value.workspaceRoot;
        const handle = yield* vcs.detect({ cwd });
        const head =
          handle?.kind === "git"
            ? yield* handle.driver.execute({
                operation: "WorkflowWorkspace.describe",
                cwd,
                args: ["rev-parse", "--abbrev-ref", "HEAD", "HEAD"],
                allowNonZeroExit: true,
              })
            : null;
        const [branch, commit] =
          head?.exitCode === 0 ? head.stdout.trim().split("\n") : [undefined, undefined];
        const existing = new Set<string>();
        for (const file of paths) {
          if (yield* fs.exists(path.join(cwd, file))) existing.add(file);
        }
        return {
          cwd,
          branch: branch && branch !== "HEAD" ? branch : null,
          commit: commit || null,
          existing,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Workflow workspace read failed", { projectId, error }).pipe(
            Effect.as(empty),
          ),
        ),
      );

    const threadDiff = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = yield* engine.getCheckpointContext(threadId);
        const completed = new Set(
          context.runs.filter((run) => run.status === "completed").map((run) => run.id),
        );
        const last = context.checkpoints
          .filter(
            (checkpoint) =>
              checkpoint.status === "ready" &&
              checkpoint.appRunOrdinal !== null &&
              checkpoint.runId !== null &&
              completed.has(checkpoint.runId),
          )
          .reduce<(typeof context.checkpoints)[number] | null>(
            (latest, checkpoint) =>
              latest === null || checkpoint.appRunOrdinal! > latest.appRunOrdinal!
                ? checkpoint
                : latest,
            null,
          );
        const root = context.checkpointScopes.find((scope) => scope.kind === "root_run");
        if (!last || !root) return null;
        // Same range as the thread's full diff: the root scope baseline to the last turn.
        const fromRef = yield* checkpointRefForScopeOrdinal({
          scopeId: root.id,
          ordinalWithinScope: 0,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        const key = `${fromRef}\0${last.ref}`;
        let stats = diffStats.get(key);
        if (!stats) {
          const files = parseTurnDiffFilesFromNumstat(
            yield* checkpoints.diffCheckpoints({
              cwd: root.cwd,
              fromCheckpointRef: fromRef,
              toCheckpointRef: last.ref,
              fallbackFromToHead: false,
              ignoreWhitespace: false,
              format: "numstat",
            }),
          );
          stats = {
            fromRef,
            toRef: last.ref,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            fileCount: files.length,
          };
          if (diffStats.size >= 512) diffStats.clear();
          diffStats.set(key, stats);
        }
        return { ...stats, turnCount: last.appRunOrdinal! };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Workflow stage diff read failed", { threadId, error }).pipe(
            Effect.as(null),
          ),
        ),
      );

    return WorkflowWorkspace.of({ describe, threadDiff });
  }),
);

/** A workspace with no repository, files or checkpoints, for tests that don't read them. */
export const WorkflowWorkspaceEmpty = Layer.succeed(
  WorkflowWorkspace,
  WorkflowWorkspace.of({
    describe: () => Effect.succeed(empty),
    threadDiff: () => Effect.succeed(null),
  }),
);
