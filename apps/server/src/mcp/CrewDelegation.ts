import type { ModelSelection, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** What a feature crew member delegated to runs as. */
export interface CrewMemberRun {
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

/**
 * Looks up a feature's crew member by name, for `delegate_task` with `crewMember`. Bosun's
 * feature runtime provides it; without it, `crewMember` is refused.
 */
export class CrewDelegation extends Context.Service<
  CrewDelegation,
  {
    readonly member: (
      featureId: string,
      name: string,
    ) => Effect.Effect<CrewMemberRun | null, Error>;
    /** The names the feature's lead may delegate to. */
    readonly names: (featureId: string) => Effect.Effect<ReadonlyArray<string>, Error>;
  }
>()("t3/mcp/CrewDelegation") {}
