import { describe, expect, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";

import { freshStartBriefing } from "./headquartersFreshStart.ts";
import { at, nodeId, runId, threadId } from "./headquartersFreshStart.testkit.ts";

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
