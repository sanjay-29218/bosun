import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

/**
 * Marks a project's issue list as changed on its host. `IssueService` keys its shared read by
 * the revision, so the next read goes to the host, and open boards hear about it. It sits below
 * the orchestration runtime so turn finalization can call it without depending on issues.
 */
export class IssueRefreshes extends Context.Service<
  IssueRefreshes,
  {
    readonly revision: (projectId: ProjectId) => number;
    readonly refresh: (projectId: ProjectId) => Effect.Effect<void>;
    readonly changes: Stream.Stream<ProjectId>;
  }
>()("t3/issues/IssueRefreshes") {}

export const layer = Layer.effect(
  IssueRefreshes,
  Effect.gen(function* () {
    const revisions = new Map<ProjectId, number>();
    const pubsub = yield* PubSub.unbounded<ProjectId>();
    return IssueRefreshes.of({
      revision: (projectId) => revisions.get(projectId) ?? 0,
      refresh: Effect.fn("IssueRefreshes.refresh")(function* (projectId) {
        revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
        yield* PubSub.publish(pubsub, projectId);
      }),
      changes: Stream.fromPubSub(pubsub),
    });
  }),
);
