import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { botListRowSummary } from "./botListRow.logic";

const idle = { failed: false, working: false, unread: false };
const message = (text: string) => ({
  id: MessageId.make("message:1"),
  role: "assistant" as const,
  text,
  updatedAt: DateTime.makeUnsafe("2026-11-07T10:00:00.000Z"),
});

describe("botListRowSummary", () => {
  it("shows the last line and its time", () => {
    expect(botListRowSummary(0, idle, message("Shipped the fix"))).toEqual({
      mark: null,
      unread: false,
      preview: "Shipped the fix",
      time: "2026-11-07T10:00:00.000Z",
    });
  });

  it("says No messages yet without a message", () => {
    for (const latest of [null, undefined]) {
      expect(botListRowSummary(0, undefined, latest)).toEqual({
        mark: null,
        unread: false,
        preview: "No messages yet",
        time: null,
      });
    }
  });

  it("keeps the time of a message with no text", () => {
    expect(botListRowSummary(0, undefined, message(""))).toEqual({
      mark: null,
      unread: false,
      preview: "Attachment",
      time: "2026-11-07T10:00:00.000Z",
    });
  });

  it("marks Needs you over working, like the rail", () => {
    const working = { ...idle, working: true };
    expect(botListRowSummary(2, working, null).mark).toBe("needs-you");
    expect(botListRowSummary(0, working, null).mark).toBe("working");
    expect(botListRowSummary(0, { ...idle, failed: true, working: true }, null).mark).toBeNull();
  });

  it("flags an unseen finished run only when nothing else is marked", () => {
    expect(botListRowSummary(0, { ...idle, unread: true }, null)).toMatchObject({
      mark: null,
      unread: true,
    });
    expect(botListRowSummary(1, { ...idle, unread: true }, null).unread).toBe(false);
  });
});
