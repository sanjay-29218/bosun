import {
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadBackgroundLivenessService } from "../orchestration/ThreadBackgroundLiveness.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";

// The turn projection is the lease clock: a request to interrupt is not a release.
// Deleted threads retain ownership until the deletion worker confirms provider shutdown.
export const featureWriter = Effect.fn("featureWriter")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  const background = yield* ThreadBackgroundLivenessService;
  const rows = yield* sql<{ threadId: string; active: number }>`
    SELECT l.thread_id AS threadId, (t.thread_id IS NULL OR t.deleted_at IS NOT NULL OR
      EXISTS (SELECT 1 FROM projection_turns p WHERE p.thread_id = l.thread_id AND p.state IN ('pending', 'running')) OR
      EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = l.thread_id AND s.status IN ('starting', 'running'))) AS active FROM feature_writer_leases l
    LEFT JOIN projection_threads t ON t.thread_id = l.thread_id
    WHERE l.path = ${normalizeProjectPathForComparison(path)} LIMIT 1
  `;
  const row = rows[0];
  return row && (row.active || background.getThreadBackgroundLiveness(row.threadId) !== null)
    ? ThreadId.make(row.threadId)
    : null;
});

export const claimFeatureWriter = Effect.fn("claimFeatureWriter")(function* (
  command: OrchestrationCommand,
  model: OrchestrationReadModel,
) {
  if (command.type !== "thread.turn.start" && command.type !== "thread.meta.update") return;
  const sql = yield* SqlClient.SqlClient;
  const registered =
    yield* sql`SELECT 1 FROM feature_checkouts WHERE mode = 'worktree' AND path IS NOT NULL LIMIT 1`;
  if (registered.length === 0) return;
  const thread = model.threads.find((thread) => thread.id === command.threadId);
  const project = thread && model.projects.find((project) => project.id === thread.projectId);
  if (!thread || !project) return;
  const fs = yield* FileSystem.FileSystem;
  const rawCwd = thread.worktreePath ?? project.workspaceRoot;
  const cwd = normalizeProjectPathForComparison(
    yield* fs.realPath(rawCwd).pipe(Effect.catch(() => Effect.succeed(rawCwd))),
  );
  if (command.type === "thread.meta.update") {
    if (command.worktreePath === undefined || command.worktreePath === thread.worktreePath) return;
    if ((yield* featureWriter(cwd)) === thread.id)
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Stop the feature writer before changing its checkout",
      });
    return;
  }
  const checkouts =
    yield* sql`SELECT feature_id, phase FROM feature_checkouts WHERE path = ${cwd} AND mode = 'worktree' LIMIT 1`;
  if (checkouts.length === 0) return;
  if (checkouts[0]?.phase !== "ready")
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: "Wait for feature checkout setup to finish or retry its failed setup before writing",
    });
  const holder = yield* featureWriter(cwd);
  if (holder && holder !== thread.id)
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Feature checkout is owned by writer thread ${holder}. Wait for its turn to finish or stop it before retrying.`,
    });
  // Also fence turns that were running before this checkout was registered.
  const active = yield* sql<{ threadId: string; path: string }>`
    SELECT t.thread_id AS threadId, coalesce(t.worktree_path, p.workspace_root) AS path FROM projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.thread_id != ${thread.id}
      AND (EXISTS (SELECT 1 FROM projection_turns r WHERE r.thread_id = t.thread_id AND r.state IN ('pending', 'running'))
        OR EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = t.thread_id AND s.status IN ('starting', 'running')))
  `;
  const paths = yield* Effect.forEach(
    active,
    (other) =>
      fs.realPath(other.path).pipe(
        Effect.catch(() => Effect.succeed(other.path)),
        Effect.map((path) => ({ ...other, path: normalizeProjectPathForComparison(path) })),
      ),
    { concurrency: 8 },
  );
  const other = paths.find((other) => other.path === cwd);
  if (other)
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Feature checkout is busy in thread ${other.threadId}`,
    });
  yield* sql`INSERT INTO feature_writer_leases (path, thread_id, command_id) VALUES (${cwd}, ${thread.id}, ${command.commandId})
    ON CONFLICT(path) DO UPDATE SET thread_id = excluded.thread_id, command_id = excluded.command_id`;
});
