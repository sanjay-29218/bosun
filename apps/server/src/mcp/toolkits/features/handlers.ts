// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FeatureService } from "../../../features/FeatureService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, readCaller, threadNotFound, unavailable } from "../../threadAccess.ts";
import { asWorkflowManager, fullAccessCaller } from "../workflows/access.ts";
import { FeaturesToolkit } from "./tools.ts";

const failed = (error: unknown) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: String(error) });
const hash = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** `threadId`, or the caller's own thread. Callers are checked before this. */
const targetThread = Effect.fn("FeaturesToolkit.targetThread")(function* (
  threadId: ThreadId | undefined,
) {
  const { scope, threads, caller } = yield* loadCaller();
  const targetId = threadId ?? caller?.id;
  if (targetId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Pass threadId: this MCP client is not running inside a T3 thread.",
    });
  }
  const shell = yield* threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(threads, targetId, "The thread was not found.");
  }
  return { actorId: scope.thread?.threadId ?? "mcp", thread: shell };
});

/**
 * A bot's threads attach and detach with "Manage workflows". Any other thread attaches with full
 * access, since attaching starts the feature's crew runs, and detaches with thread control.
 */
export const layer = McpToolAccess.toLayer(FeaturesToolkit, {
  t3_feature_attach_thread: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      yield* asWorkflowManager(
        fullAccessCaller(
          "Attaching a thread to a workflow needs a live full-access/default calling thread or a full-access client.",
        ),
      );
      const { actorId, thread } = yield* targetThread(input.threadId);
      const features = yield* FeatureService;
      return yield* features
        .attachThread({
          // The same thread, workflow and stage always name the same feature, so a retry is safe.
          featureId:
            input.featureId ?? `feature:${hash(thread.id, input.workflowId, input.stageId)}`,
          projectId: thread.projectId,
          threadId: thread.id,
          workflowId: input.workflowId,
          stageId: input.stageId,
          title: input.title?.trim() || thread.title,
          actorId,
        })
        .pipe(Effect.mapError(failed));
    }),
  ),
  t3_feature_detach_thread: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        yield* asWorkflowManager(readCaller());
        const { actorId, thread } = yield* targetThread(input.threadId);
        const features = yield* FeatureService;
        return yield* features
          .detachThread({
            projectId: thread.projectId,
            threadId: thread.id,
            requestId: input.requestId ?? `detach:${NodeCrypto.randomUUID()}`,
            actorId,
          })
          .pipe(Effect.mapError(failed));
      }),
  ),
});
