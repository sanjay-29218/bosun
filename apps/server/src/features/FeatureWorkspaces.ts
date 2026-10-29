// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import type { CrewWorkspace } from "../crew/CrewStore.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class FeatureWorkspaceError extends Error {
  readonly _tag = "FeatureWorkspaceError";
}

const branchSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "feature";

export class FeatureWorkspaces extends Context.Service<
  FeatureWorkspaces,
  {
    /**
     * The worktree the feature behind a workflow stage handoff works in, made from its base
     * branch the first time a stage starts. Null when the feature works in the project's checkout.
     */
    readonly forStageHandoff: (
      handoffId: string,
    ) => Effect.Effect<CrewWorkspace | null, FeatureWorkspaceError>;
  }
>()("t3/features/FeatureWorkspaces") {}

export const FeatureWorkspacesLive = Layer.effect(
  FeatureWorkspaces,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const git = yield* GitWorkflowService;
    // Two stages of one feature must not each make a worktree.
    const making = yield* Semaphore.make(1);
    const failed = (reason: string) => () => new FeatureWorkspaceError(reason);

    // Traced by `forStageHandoff`, which only adds the lock around it.
    const ensure = Effect.fnUntraced(function* (handoffId: string) {
      const rows = yield* sql<{
        readonly featureId: string;
        readonly projectId: string;
        readonly title: string;
        readonly workspace: "worktree" | "local";
        readonly baseBranch: string | null;
        readonly branch: string | null;
        readonly worktreePath: string | null;
      }>`
        SELECT f.id AS featureId, f.project_id AS projectId, f.title, f.workspace,
          f.base_branch AS baseBranch, f.branch, f.worktree_path AS worktreePath
        FROM workflow_stage_handoffs h JOIN features f ON f.id = h.feature_id
        WHERE h.id = ${handoffId}
      `.pipe(Effect.mapError(failed("The feature's workspace is unreadable")));
      const feature = rows[0];
      if (!feature || feature.workspace === "local") return null;
      if (feature.branch && feature.worktreePath) {
        return { branch: feature.branch, worktreePath: feature.worktreePath };
      }
      const project = Option.getOrUndefined(
        yield* projects
          .get(ProjectId.make(feature.projectId))
          .pipe(Effect.mapError(failed("The feature's project is unavailable"))),
      );
      if (!project) return yield* Effect.fail(new FeatureWorkspaceError("Project not found"));
      const base =
        feature.baseBranch ??
        (yield* git.currentBranch(project.workspaceRoot).pipe(Effect.orElseSucceed(() => null)));
      // Not a Git repository, or a detached checkout: there is nothing to branch from.
      if (base === null) {
        yield* sql`UPDATE features SET workspace = 'local' WHERE id = ${feature.featureId}`.pipe(
          Effect.mapError(failed("The feature's workspace is unwritable")),
        );
        return null;
      }
      const suffix = NodeCrypto.createHash("sha256")
        .update(feature.featureId)
        .digest("hex")
        .slice(0, 6);
      const created = yield* git
        .createWorktree({
          cwd: project.workspaceRoot,
          refName: base,
          newRefName: `bosun/${branchSlug(feature.title)}-${suffix}`,
          baseRefName: base,
          path: null,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new FeatureWorkspaceError(`Couldn't make the feature's worktree: ${error.message}`),
          ),
        );
      const workspace = {
        branch: created.worktree.refName,
        worktreePath: created.worktree.path,
      };
      yield* sql`
        UPDATE features SET branch = ${workspace.branch}, worktree_path = ${workspace.worktreePath}
        WHERE id = ${feature.featureId}
      `.pipe(Effect.mapError(failed("The feature's workspace is unwritable")));
      return workspace;
    });

    return {
      forStageHandoff: Effect.fn("FeatureWorkspaces.forStageHandoff")(function* (handoffId) {
        return yield* making.withPermits(1)(ensure(handoffId));
      }),
    };
  }),
);
