import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { allBotsRowSummary } from "./allBots.logic";

const idle = { failed: false, working: false, unread: false };
const message = (text: string) => ({
  id: MessageId.make("message:1"),
  role: "assistant" as const,
  text,
  updatedAt: DateTime.makeUnsafe("2026-11-07T10:00:00.000Z"),
});

describe("allBotsRowSummary", () => {
  it("shows the last line and its time", () => {
    expect(allBotsRowSummary(0, idle, message("Shipped the fix"))).toEqual({
      mark: null,
      preview: "Shipped the fix",
      time: "2026-11-07T10:00:00.000Z",
    });
  });

  it("says No messages yet without a line", () => {
    for (const latest of [null, undefined, message("")]) {
      expect(allBotsRowSummary(0, undefined, latest)).toEqual({
        mark: null,
        preview: "No messages yet",
        time: null,
      });
    }
  });

  it("marks Needs you over working, like the rail", () => {
    const working = { ...idle, working: true };
    expect(allBotsRowSummary(2, working, null).mark).toBe("needs-you");
    expect(allBotsRowSummary(0, working, null).mark).toBe("working");
    expect(allBotsRowSummary(0, { ...idle, failed: true, working: true }, null).mark).toBeNull();
  });
});
