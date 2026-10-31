import { describe, expect, it } from "vite-plus/test";

import { stageTurnVerdict } from "./StageTurn.ts";

describe("stageTurnVerdict", () => {
  it.each([
    ["no turn yet", undefined, false, false, { kind: "wait" }],
    ["preparing", "preparing", false, false, { kind: "wait" }],
    ["running", "running", false, false, { kind: "wait" }],
    ["waiting on background work", "waiting", false, false, { kind: "wait" }],
    ["ended without a result", "completed", false, false, { kind: "remind" }],
    [
      "ended again after the reminder",
      "completed",
      true,
      false,
      { kind: "fail", detail: expect.stringContaining("crew_respond"), retry: true },
    ],
    [
      "cut by a restart that continues it",
      "cancelled",
      false,
      true,
      { kind: "await-continuation" },
    ],
    ["cut by a restart that won't continue it", "cancelled", false, false, { kind: "continue" }],
    [
      "stopped by a person",
      "interrupted",
      false,
      false,
      { kind: "fail", detail: "The stage thread was stopped", retry: false },
    ],
    [
      "failed",
      "failed",
      false,
      false,
      { kind: "fail", detail: "The stage thread's turn failed", retry: true },
    ],
  ] as const)("%s", (_name, status, reminded, continuationPending, verdict) => {
    expect(
      stageTurnVerdict({
        run: status === undefined ? undefined : { status },
        reminded,
        continuationPending,
      }),
    ).toEqual(verdict);
  });
});
