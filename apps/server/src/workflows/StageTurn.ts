import type { OrchestrationV2Run } from "@t3tools/contracts";

/** What a stage reports when it needs a person's answer instead of one of its outcomes. */
export const NEEDS_INPUT = "needs_input";

/** What the workflow does about a running stage, from its thread's latest turn. */
export type StageTurnVerdict =
  | { readonly kind: "wait" }
  | { readonly kind: "await-continuation" }
  | { readonly kind: "remind" }
  | { readonly kind: "continue" }
  | { readonly kind: "fail"; readonly detail: string; readonly retry: boolean };

/**
 * A stage reports its result with crew_respond while its turn runs. A turn that ends without one
 * gets one reminder in the same thread. A turn a restart cancelled waits for the server's own
 * continuation, or is told to continue when none comes. A person's stop or deleted thread
 * fails the stage for that person; a failed turn fails it for the retry policy.
 */
export const stageTurnVerdict = (input: {
  readonly run: Pick<OrchestrationV2Run, "status"> | undefined;
  readonly reminded: boolean;
  readonly continuationPending: boolean;
  readonly threadDeleted: boolean;
}): StageTurnVerdict => {
  if (input.threadDeleted) {
    return { kind: "fail", detail: "The stage thread was deleted", retry: false };
  }
  switch (input.run?.status) {
    case "completed":
      return input.reminded
        ? {
            kind: "fail",
            detail: "The stage ended without reporting a result with crew_respond",
            retry: true,
          }
        : { kind: "remind" };
    case "cancelled":
      return input.continuationPending ? { kind: "await-continuation" } : { kind: "continue" };
    case "interrupted":
    case "rolled_back":
      return { kind: "fail", detail: "The stage thread was stopped", retry: false };
    case "failed":
      return { kind: "fail", detail: "The stage thread's turn failed", retry: true };
    default:
      return { kind: "wait" };
  }
};
