import type { CrewAction } from "@t3tools/client-runtime/crew-stage";

/** Labels and one-line consequences, shared by the banner menus, Feature tab and palette. */
export const CREW_ACTION_COPY: Record<
  CrewAction,
  { readonly label: string; readonly description: string }
> = {
  approve: { label: "Approve", description: "Hand this stage's result to the next stage" },
  "request-changes": {
    label: "Request changes",
    description: "Run the stage again with your note from the composer",
  },
  retry: { label: "Retry stage", description: "Runs the stage again with the error attached" },
  "take-over": {
    label: "Take over",
    description: "You drive this thread, then choose Mark stage done",
  },
  "mark-done": { label: "Mark stage done", description: "Hand your result to the next stage" },
  "send-back": {
    label: "Send back to…",
    description: "An earlier stage reruns with the error attached",
  },
  skip: { label: "Skip stage", description: "Continue without this stage's changes" },
  "accept-as-is": { label: "Accept as is", description: "Move on with the current result" },
  "one-more-round": { label: "One more round", description: "Allow the loop to run once more" },
  pause: { label: "Pause feature", description: "Current work may finish; the next stage waits" },
  resume: { label: "Resume feature", description: "Continue from where it paused" },
  cancel: {
    label: "Cancel feature",
    description: "Keeps the branch and threads. Reopen it later.",
  },
  reopen: { label: "Reopen feature", description: "Continue a cancelled or finished feature" },
  "start-now": { label: "Start now", description: "Run the queued stage past the agent limit" },
};
