// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
     * Where the feature works: its worktree, or a branch its lead's thread checks out from the
     * base branch as it starts, so starting never waits on the checkout. Null when the feature
     * works in the project's checkout.
     */
    readonly forFeature: (
      featureId: string,
    ) => Effect.Effect<CrewWorkspace | null, FeatureWorkspaceError>;
  }
>()("t3/features/FeatureWorkspaces") {}

export const FeatureWorkspacesLive = Layer.effect(
  FeatureWorkspaces,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const git = yield* GitWorkflowService;
    const failed = (reason: string) => () => new FeatureWorkspaceError(reason);

    const forFeature = Effect.fn("FeatureWorkspaces.forFeature")(function* (featureId: string) {
      const rows = yield* sql<{
        readonly featureId: string;
        readonly projectId: string;
        readonly title: string;
        readonly workspace: "worktree" | "local";
        readonly baseBranch: string | null;
        readonly branch: string | null;
        readonly worktreePath: string | null;
      }>`
        SELECT id AS featureId, project_id AS projectId, title, workspace,
          base_branch AS baseBranch, branch, worktree_path AS worktreePath
        FROM features WHERE id = ${featureId}
      `.pipe(Effect.mapError(failed("The feature's workspace is unreadable")));
      const feature = rows[0];
      if (!feature || feature.workspace === "local") return null;
      // Features started before their leads made the worktree recorded it here.
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
      return { branch: `bosun/${branchSlug(feature.title)}-${suffix}`, baseRef: base };
    });

    return { forFeature };
  }),
);
