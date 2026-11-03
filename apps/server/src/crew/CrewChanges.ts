import type { CrewRevision } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Counts changes to bots, the Library (roles and workflows) and features, whoever made them: a
 * client, an agent through MCP, or the server. Clients get the counts with their server config
 * and re-read a list when its count moves, so a bot an agent creates shows up everywhere at once.
 */
export class CrewChanges extends Context.Service<
  CrewChanges,
  {
    readonly revision: Effect.Effect<CrewRevision>;
    /** The current counts, then each change, with no gap between them. */
    readonly changes: Stream.Stream<CrewRevision>;
    readonly bump: (scope: keyof CrewRevision) => Effect.Effect<void>;
  }
>()("t3/crew/CrewChanges") {}

export const CrewChangesLive = Layer.effect(
  CrewChanges,
  Effect.gen(function* () {
    const revision = yield* SubscriptionRef.make<CrewRevision>({
      bots: 0,
      library: 0,
      features: 0,
    });
    return CrewChanges.of({
      revision: SubscriptionRef.get(revision),
      changes: SubscriptionRef.changes(revision),
      bump: Effect.fn("CrewChanges.bump")(function* (scope) {
        yield* SubscriptionRef.update(revision, (current) => ({
          ...current,
          [scope]: current[scope] + 1,
        }));
      }),
    });
  }),
);

/**
 * What a service needs to report its changes, captured as the service is built: `notify` bumps
 * a count, and `notifying` wraps a method so it bumps one after it succeeds. Services built
 * without `CrewChanges` (in tests) get ones that do nothing.
 */
export const crewChangeNotifier = Effect.serviceOption(CrewChanges).pipe(
  Effect.map((changes) => {
    const notify = (scope: keyof CrewRevision): Effect.Effect<void> =>
      Option.isSome(changes) ? changes.value.bump(scope) : Effect.void;
    // Untraced: the method it wraps already has its span.
    const notifying =
      (scope: keyof CrewRevision) =>
      <Args extends ReadonlyArray<unknown>, A, E>(method: (...args: Args) => Effect.Effect<A, E>) =>
        Effect.fnUntraced(function* (...args: Args) {
          const result = yield* method(...args);
          yield* notify(scope);
          return result;
        });
    return { notify, notifying };
  }),
);
