import type { OrchestrationV2Run } from "@t3tools/contracts";

/** What a stage reports when it needs a person's answer instead of one of its outcomes. */
export const NEEDS_INPUT = "needs_input";

/** What the workflow does about a running stage, from its thread's latest turn. */
export type StageTurnVerdict =
  | { readonly kind: "wait" }
  | { readonly kind: "remind" }
  | { readonly kind: "fail"; readonly detail: string };

/**
 * A stage reports its result with crew_respond while its turn runs. A turn that ends without one
 * gets one reminder in the same thread; a turn that ends after it, or ends badly, fails the stage.
 */
export const stageTurnVerdict = (input: {
  readonly run: Pick<OrchestrationV2Run, "status"> | undefined;
  readonly reminded: boolean;
}): StageTurnVerdict => {
  const status = input.run?.status;
  switch (status) {
    case "completed":
      return input.reminded
        ? { kind: "fail", detail: "The stage ended without reporting a result with crew_respond" }
        : { kind: "remind" };
    case "failed":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return { kind: "fail", detail: `The stage thread's turn ${status.replace("_", " ")}` };
    default:
      return { kind: "wait" };
  }
};
