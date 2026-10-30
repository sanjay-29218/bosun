import { ThreadId, type ThreadCrewHandoff } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentCrewHandoffWait } from "./crewHandoffs.ts";

const builderThread = ThreadId.make("crew-builder");

const handoff = (
  overrides: Partial<ThreadCrewHandoff> & Pick<ThreadCrewHandoff, "id">,
): ThreadCrewHandoff => ({
  member: "Builder",
  threadId: builderThread,
  status: "running",
  task: "Fix the login redirect",
  question: null,
  error: null,
  createdAt: "2026-10-30T10:01:00.000Z",
  updatedAt: "2026-10-30T10:01:00.000Z",
  ...overrides,
});

describe("presentCrewHandoffWait", () => {
  it("names the member a single open handoff waits on", () => {
    expect(presentCrewHandoffWait([handoff({ id: "h1" })], null)).toEqual({
      kind: "waiting",
      title: "Waiting on Builder",
      detail: "Fix the login redirect",
      handoffIds: ["h1"],
      threadId: builderThread,
      startedAt: "2026-10-30T10:01:00.000Z",
    });
  });

  it("joins several members and surfaces a question among them", () => {
    const wait = presentCrewHandoffWait(
      [
        handoff({ id: "h1" }),
        handoff({
          id: "h2",
          member: "QA",
          threadId: ThreadId.make("crew-qa"),
          status: "needs-input",
          question: "Which browsers?",
        }),
      ],
      null,
    );
    expect(wait).toMatchObject({
      kind: "waiting",
      title: "Waiting on Builder and QA",
      detail: "QA asked: Which browsers?",
      threadId: null,
      startedAt: null,
    });
  });

  it("shows a lone question as the member asking", () => {
    const wait = presentCrewHandoffWait(
      [handoff({ id: "h1", status: "needs-input", question: "Keep the query?" })],
      null,
    );
    expect(wait).toMatchObject({
      kind: "question",
      title: "Builder asked a question",
      detail: "Keep the query?",
    });
  });

  it("shows a failure only until the thread finishes a turn after it", () => {
    const failed = [handoff({ id: "h1", status: "failed", error: "Tests timed out" })];
    expect(presentCrewHandoffWait(failed, "2026-10-30T09:30:00.000Z")).toMatchObject({
      kind: "failed",
      title: "Builder failed",
      detail: "Tests timed out",
      handoffIds: ["h1"],
    });
    expect(presentCrewHandoffWait(failed, "2026-10-30T10:05:00.000Z")).toBeNull();
    expect(presentCrewHandoffWait([], null)).toBeNull();
  });
});
