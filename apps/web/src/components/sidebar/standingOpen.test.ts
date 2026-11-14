import { describe, expect, it } from "vite-plus/test";

import { consumeLeaveRail, leaveRailOnNextOpen } from "./standingOpen";

describe("leaveRailOnNextOpen", () => {
  it("leaves the rail alone for the armed thread only, once", () => {
    leaveRailOnNextOpen("env", "thread-a");
    expect(consumeLeaveRail("env:thread-a")).toBe(true);
    expect(consumeLeaveRail("env:thread-a")).toBe(false);
  });

  it("is cleared by any other navigation, so a later open of the thread is followed", () => {
    leaveRailOnNextOpen("env", "thread-a");
    expect(consumeLeaveRail("env:thread-b")).toBe(false);
    expect(consumeLeaveRail("env:thread-a")).toBe(false);
  });
});
