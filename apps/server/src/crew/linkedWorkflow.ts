import { WorkflowSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The workflow a linked environment's bot sent with one request, kept with that request's run:
 * the snapshot, and the environments it went between, which refusals name.
 */
export const LinkedWorkflow = Schema.Struct({
  snapshot: WorkflowSnapshot,
  /** This environment's label. */
  here: Schema.String,
  /** The label of the environment the request came from. */
  from: Schema.String,
});
export type LinkedWorkflow = typeof LinkedWorkflow.Type;

const LinkedWorkflowJson = Schema.fromJsonString(LinkedWorkflow);
export const encodeLinkedWorkflow = Schema.encodeSync(LinkedWorkflowJson);
const decodeOption = Schema.decodeUnknownOption(LinkedWorkflowJson);
/** Null for no record, or one this version can't read. */
export const decodeLinkedWorkflow = (json: string | null | undefined) =>
  json == null ? null : Option.getOrNull(decodeOption(json));

const SnapshotJson = Schema.fromJsonString(WorkflowSnapshot);
export const encodeWorkflowSnapshot = Schema.encodeSync(SnapshotJson);
const decodeSnapshotOption = Schema.decodeUnknownOption(SnapshotJson);
export const decodeWorkflowSnapshot = (json: string | null | undefined) =>
  json == null ? null : Option.getOrNull(decodeSnapshotOption(json));
