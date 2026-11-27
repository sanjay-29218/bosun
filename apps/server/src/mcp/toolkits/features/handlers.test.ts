import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LibraryDetachInput,
  type LibraryImportInput,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CrewService } from "../../../crew/CrewService.ts";
import { LibraryImports } from "../../../crew/LibraryImports.ts";
import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as FeaturesHandlers from "./handlers.ts";
import { FeaturesToolkit } from "./tools.ts";

const studio = EnvironmentId.make("env-studio");
const threadId = ThreadId.make("thread:person");

/** Calls `t3_library_import` as a full-access thread; returns what reached the library. */
const callImport = (params: Record<string, unknown>) => {
  const detached: Array<typeof LibraryDetachInput.Type> = [];
  const imported: Array<typeof LibraryImportInput.Type> = [];
  return Effect.gen(function* () {
    const toolkit = yield* FeaturesToolkit;
    const results = yield* toolkit
      .handle("t3_library_import", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = results.at(-1);
    expect(last?.isFailure).toBe(false);
    return { detached, imported, result: last?.result };
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FeaturesHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("env-laptop"),
              requestNamespace: "provider:library",
              thread: {
                threadId,
                providerSessionId: "provider:library",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed(liveThreadShell(id, { runtimeMode: "full-access" })),
            }),
            Layer.mock(LibraryImports)({
              detach: (input) => Effect.sync(() => void detached.push(input)),
              importItems: (input) =>
                Effect.sync(() => {
                  imported.push(input);
                  return { imported: [], skipped: [] };
                }),
            }),
            Layer.mock(CrewService)({}),
            Layer.mock(FeatureService)({}),
            Layer.mock(ProjectRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          ),
        ),
      ),
    ),
  );
};

it.effect("a role and a workflow that share an id are each named by their own list", () =>
  Effect.gen(function* () {
    const keptRole = yield* callImport({
      environmentId: studio,
      roleIds: ["review"],
      mode: "keep",
    });
    expect(keptRole.detached).toEqual([{ kind: "role", id: "review", mode: "detach" }]);
    expect(keptRole.result).toEqual({ kept: 1 });

    const skippedWorkflow = yield* callImport({
      environmentId: studio,
      workflowIds: ["review"],
      mode: "skip",
    });
    expect(skippedWorkflow.detached).toEqual([{ kind: "workflow", id: "review", mode: "skip" }]);
    expect(skippedWorkflow.result).toEqual({ updatesSkipped: 1 });

    const importedRole = yield* callImport({ environmentId: studio, roleIds: ["review"] });
    expect(importedRole.imported).toEqual([
      { sourceEnvironmentId: studio, roleIds: ["review"], workflowIds: [], replace: false },
    ]);
  }),
);
