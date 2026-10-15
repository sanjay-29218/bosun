import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotStore } from "../../../bots/BotStore.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { FeatureExecutionService } from "../../../features/FeatureExecutionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotToolFailedError } from "../bots/tools.ts";
import { FeaturesToolkit } from "./tools.ts";

const isCapabilityError = Schema.is(McpCapabilityUnavailableError);

export const FeaturesToolkitHandlersLive = FeaturesToolkit.toLayer(
  Effect.gen(function* () {
    const store = yield* BotStore;
    const handoffs = yield* BotHandoffStore;
    const features = yield* FeatureExecutionService;
    const caller = Effect.fn("features.caller")(function* (grant: string) {
      yield* McpInvocationContext.requireMcpCapability("bots");
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const id = yield* handoffs.getRunByThread(scope.threadId);
      const run = id ? yield* store.getRun(id) : null;
      if (!run?.allowedTools.includes(grant))
        return yield* new BotToolFailedError({ reason: `Caller needs the ${grant} grant` });
      return run;
    });
    const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isCapabilityError(error) ? error : new BotToolFailedError({ reason: String(error) }),
        ),
      );
    return {
      features_inspect: (input) =>
        scoped(
          Effect.gen(function* () {
            const run = yield* caller("features.status");
            return yield* features.inspect(input.featureId, run.projectId);
          }),
        ),
      features_record_artifact: (input) =>
        scoped(
          Effect.gen(function* () {
            const run = yield* caller("features.artifacts");
            if (input.status === "succeeded" && !run.allowedTools.includes("external.write"))
              return yield* new BotToolFailedError({
                reason: "Reporting a successful external write requires external.write",
              });
            return yield* features.recordArtifact({
              ...input,
              projectId: run.projectId,
              threadId: run.threadId,
              actorId: run.id,
            });
          }),
        ),
    };
  }),
);
