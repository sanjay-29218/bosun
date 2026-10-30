import { describe, expect, it } from "@effect/vitest";
import { MessageId, RunId } from "@t3tools/contracts";

import { FRESH_START_TOKENS, freshStartBriefing, freshStartDue } from "./headquartersFreshStart.ts";
import {
  at,
  freshStartRecords as records,
  nodeId,
  runId,
  threadId,
} from "./headquartersFreshStart.testkit.ts";

describe("freshStartDue", () => {
  it("starts fresh only after the latest turn of a large, idle conversation", () => {
    expect(freshStartDue(records(), runId)).toBe(true);
    expect(freshStartDue(records(FRESH_START_TOKENS - 1), runId)).toBe(false);
    const queued = records();
    queued.runs = [
      ...queued.runs,
      { ...queued.runs[0]!, id: RunId.make("run-2"), ordinal: 2, status: "queued" },
    ];
    expect(freshStartDue(queued, runId)).toBe(false);
    const fresh = records();
    fresh.thread = { ...fresh.thread, activeProviderThreadId: null };
    expect(freshStartDue(fresh, runId)).toBe(false);
    const archived = records();
    archived.thread = { ...archived.thread, archivedAt: at(0) };
    expect(freshStartDue(archived, runId)).toBe(false);
  });
});

describe("freshStartBriefing", () => {
  it("carries the last few messages, oldest first and clipped", () => {
    const message = (minute: number, role: "user" | "assistant" | "system", text: string) => ({
      id: MessageId.make(`message-${minute}`),
      threadId,
      runId,
      nodeId,
      role,
      text,
      attachments: [],
      streaming: false,
      createdBy: "user" as const,
      creationSource: "web" as const,
      createdAt: at(minute),
      updatedAt: at(minute),
    });
    const briefing = freshStartBriefing("Opening prompt", [
      message(5, "assistant", "x".repeat(2_000)),
      message(1, "user", "too old"),
      message(2, "user", "Start the release"),
      message(3, "system", "hidden"),
      message(4, "assistant", "Should I tag it?"),
      message(6, "user", "yes"),
    ]);
    expect(briefing.startsWith("This is a fresh session.")).toBe(true);
    expect(briefing).toContain("\n\nOpening prompt\n\n");
    expect(briefing.split("The latest messages:\n\n")[1]).toBe(
      [
        "To you: Start the release",
        "You: Should I tag it?",
        `You: ${"x".repeat(1_497)}...`,
        "To you: yes",
      ].join("\n\n"),
    );
  });
});
