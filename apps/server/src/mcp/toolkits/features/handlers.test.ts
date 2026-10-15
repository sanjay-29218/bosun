import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FeatureArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { BotStore } from "../../../bots/BotStore.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { FeatureExecutionService } from "../../../features/FeatureExecutionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FeaturesToolkitHandlersLive } from "./handlers.ts";
import { FeaturesToolkit } from "./tools.ts";

it.effect(
  "uses explicit grants and attributes successful external reports to the exact caller",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const threadId = ThreadId.make("caller-thread");
      let grants: ReadonlyArray<string> = [];
      const reports: FeatureArtifact[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(BotStore)({
          getRun: () =>
            Effect.succeed({
              id: "caller-run",
              botId: "custom-captain-label",
              projectId,
              threadId,
              taskText: "Report",
              title: "Report",
              instructions: "Report",
              allowedTools: grants,
              botRevision: 1,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6.1-sol",
              },
              runtimeMode: "approval-required",
              dispatchState: "started",
              recoveryAttempt: 0,
              lastError: null,
              createdAt: "2026-09-30",
              dispatchedAt: "2026-09-30",
            }),
        }),
        Layer.mock(BotHandoffStore)({ getRunByThread: () => Effect.succeed("caller-run") }),
        Layer.mock(FeatureExecutionService)({
          inspect: () => Effect.succeed(null),
          recordArtifact: (input) =>
            Effect.sync(() => {
              const report = {
                ...input,
                detail: input.detail ?? null,
                threadId: input.threadId ?? null,
                createdAt: "2026-09-30",
              };
              reports.push(report);
              return report;
            }),
        }),
      );
      const toolkit = yield* FeaturesToolkit.pipe(
        Effect.provide(FeaturesToolkitHandlersLive.pipe(Layer.provide(dependencies))),
      );
      const scope = {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["bots"]),
        issuedAt: 1,
      };
      const inspect = () =>
        toolkit
          .handle("features_inspect", { featureId: "feature" })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provide(dependencies),
            Effect.result,
          );
      expect((yield* inspect())._tag).toBe("Failure");
      grants = ["features.status"];
      expect((yield* inspect())._tag).toBe("Success");
      const input = {
        id: "external-report",
        featureId: "feature",
        kind: "linear" as const,
        title: "Update",
        url: "https://linear.app/example",
        status: "succeeded" as const,
      };
      const report = () =>
        toolkit
          .handle("features_record_artifact", input)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provide(dependencies),
            Effect.result,
          );
      expect((yield* report())._tag).toBe("Failure");
      grants = ["features.artifacts"];
      expect((yield* report())._tag).toBe("Failure");
      expect(reports).toHaveLength(0);
      grants = ["features.artifacts", "external.write"];
      expect((yield* report())._tag).toBe("Success");
      expect(reports[0]).toMatchObject({ actorId: "caller-run", threadId, projectId });
    }),
);
