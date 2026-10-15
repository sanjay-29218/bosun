import {
  FeatureInspection,
  FeatureRecordArtifactInput,
  FeatureArtifact,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { FeatureExecutionService } from "../../../features/FeatureExecutionService.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { BotToolFailedError } from "../bots/tools.ts";

const dependencies = [FeatureExecutionService, BotStore, BotHandoffStore, McpInvocationContext];
const failure = Schema.Union([McpCapabilityUnavailableError, BotToolFailedError]);
export const FeaturesToolkit = Toolkit.make(
  Tool.make("features_inspect", {
    description:
      "Inspect a feature's exact crew, threads, checkout writer, handoffs, and attributable artifacts. Requires the features.status grant; role names do not grant access.",
    parameters: Schema.Struct({ featureId: Schema.String }),
    success: Schema.NullOr(FeatureInspection),
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("features_record_artifact", {
    description:
      "Record a feature artifact or external action report attributed to this run and thread. Reuse id on retry. Requires features.artifacts; reporting a successful external write additionally requires external.write. This tool does not execute or approve external actions.",
    parameters: Schema.Struct({
      id: FeatureRecordArtifactInput.fields.id,
      featureId: FeatureRecordArtifactInput.fields.featureId,
      kind: FeatureRecordArtifactInput.fields.kind,
      title: FeatureRecordArtifactInput.fields.title,
      url: FeatureRecordArtifactInput.fields.url,
      status: FeatureRecordArtifactInput.fields.status,
      detail: FeatureRecordArtifactInput.fields.detail,
    }),
    success: FeatureArtifact,
    failure,
    dependencies,
  }).annotate(Tool.Idempotent, true),
);
