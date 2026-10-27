import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface WorkflowLibraryShape {
  /** Call after a workflow or role is written, so open Settings and canvases re-read them. */
  readonly changed: Effect.Effect<void>;
  readonly changes: Stream.Stream<number>;
}

/**
 * Workflows and roles change from Settings on any device and from agents' MCP tools. Clients
 * fetch the library rather than stream it, so this tells them when to fetch it again.
 */
export class WorkflowLibrary extends Context.Service<WorkflowLibrary, WorkflowLibraryShape>()(
  "t3/workflows/WorkflowLibrary",
) {}

export const WorkflowLibraryLive = Layer.effect(
  WorkflowLibrary,
  Effect.gen(function* () {
    const revision = yield* SubscriptionRef.make(0);
    return WorkflowLibrary.of({
      changed: SubscriptionRef.update(revision, (value) => value + 1),
      changes: SubscriptionRef.changes(revision).pipe(Stream.filter((value) => value > 0)),
    });
  }),
);
