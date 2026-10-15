import {
  type GitManagerServiceError,
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
  type ProjectSetupScriptRunnerResult,
  type ProjectSetupScriptRunnerError,
} from "./ProjectSetupScriptRunner.ts";
import type { CreateWorktreeOptions } from "../vcs/GitVcsDriver.ts";

export interface WorktreeBaseInput {
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly startFromOrigin?: boolean | undefined;
}
export class WorktreeBootstrapService extends Context.Service<
  WorktreeBootstrapService,
  {
    readonly setup: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
    readonly resolveBase: (
      input: WorktreeBaseInput,
      onFetch?: (
        status: "running" | "done" | "warning" | "skipped",
        detail?: string,
      ) => Effect.Effect<void>,
    ) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly create: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly remove: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/project/WorktreeBootstrapService") {}

export const WorktreeBootstrapServiceLive = Layer.effect(
  WorktreeBootstrapService,
  Effect.gen(function* () {
    const git = yield* GitWorkflowService;
    const scripts = yield* ProjectSetupScriptRunner;
    return WorktreeBootstrapService.of({
      resolveBase: Effect.fn("WorktreeBootstrapService.resolveBase")(function* (
        input,
        onFetch = () => Effect.void,
      ) {
        if (!(yield* git.isRepository(input.projectCwd))) return null;
        let base = input.baseBranch;
        if (
          input.startFromOrigin &&
          (yield* git.remoteExists({ cwd: input.projectCwd, remoteName: "origin" }))
        ) {
          yield* onFetch("running");
          yield* git.fetchRemote({
            cwd: input.projectCwd,
            remoteName: "origin",
            refName: input.baseBranch,
          });
          if (
            yield* git.remoteBranchExists({
              cwd: input.projectCwd,
              remoteName: "origin",
              refName: input.baseBranch,
            })
          ) {
            const resolved = yield* git.resolveRemoteTrackingCommit({
              cwd: input.projectCwd,
              refName: input.baseBranch,
              fallbackRemoteName: "origin",
            });
            base = resolved.commitSha;
            yield* onFetch("done", `origin/${input.baseBranch} at ${base.slice(0, 7)}`);
          } else
            yield* onFetch("warning", `origin/${input.baseBranch} not found, using local branch`);
        } else yield* onFetch("skipped");
        return (yield* git.hasCommit({ cwd: input.projectCwd, refName: base })) ? base : null;
      }),
      setup: scripts.runForThread,
      create: git.createWorktree,
      // Cleanup never silently discards a user's dirty checkout.
      remove: (input) => git.removeWorktree({ ...input, force: false }),
    });
  }),
);
