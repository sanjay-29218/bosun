// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FeatureService } from "../../../features/FeatureService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { FeaturesToolkit } from "./tools.ts";

const failed = (error: unknown) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: String(error) });
const hash = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** Feature tools act on `threadId`, or the caller's own thread, within the caller's modes. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(FeaturesToolkit, {
  t3_feature_attach_thread: writesThread((input) =>
    Effect.gen(function* () {
      const { scope, projection } = yield* readThread(input.threadId);
      const thread = projection.thread;
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
          actorId: scope.thread?.threadId ?? "mcp",
        })
        .pipe(Effect.mapError(failed));
    }),
  ),
  t3_feature_detach_thread: writesThread((input) =>
    Effect.gen(function* () {
      const { scope, projection } = yield* readThread(input.threadId);
      const thread = projection.thread;
      const features = yield* FeatureService;
      return yield* features
        .detachThread({
          projectId: thread.projectId,
          threadId: thread.id,
          requestId: input.requestId ?? `detach:${NodeCrypto.randomUUID()}`,
          actorId: scope.thread?.threadId ?? "mcp",
        })
        .pipe(Effect.mapError(failed));
    }),
  ),
});
