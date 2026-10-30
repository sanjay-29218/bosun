import { ThreadId, type ThreadCrewHandoff } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewHandoffRowLabel,
  presentCrewHandoffWait,
  type CrewHandoffThread,
} from "./crewHandoffs.ts";

const builderThread = ThreadId.make("crew-builder");
const designerThread = ThreadId.make("crew-designer");
const qaThread = ThreadId.make("crew-qa");

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

const thread = (
  crewHandoffs: ReadonlyArray<ThreadCrewHandoff>,
  lastCompletedAt: string | null = null,
): CrewHandoffThread => ({ crewHandoffs, lastCompletedAt });

const toDesigner = handoff({ id: "h2", member: "Designer", threadId: designerThread });

describe("presentCrewHandoffWait", () => {
  it("names the member a single open handoff waits on", () => {
    expect(presentCrewHandoffWait(thread([handoff({ id: "h1" })]))).toEqual({
      kind: "waiting",
      title: "Waiting on Builder",
      detail: "Fix the login redirect",
      members: ["Builder"],
      handoffIds: ["h1"],
      threadId: builderThread,
      startedAt: "2026-10-30T10:01:00.000Z",
      blockedBy: null,
    });
  });

  it("joins several members and surfaces a question among them", () => {
    const wait = presentCrewHandoffWait(
      thread([
        handoff({ id: "h1" }),
        handoff({
          id: "h2",
          member: "QA",
          threadId: qaThread,
          status: "needs-input",
          question: "Which browsers?",
        }),
      ]),
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
      thread([handoff({ id: "h1", status: "needs-input", question: "Keep the query?" })]),
    );
    expect(wait).toMatchObject({
      kind: "question",
      title: "Builder asked a question",
      detail: "Keep the query?",
    });
  });

  it("shows a failure only until the thread finishes a turn after it", () => {
    const failed = [handoff({ id: "h1", status: "failed", error: "Tests timed out" })];
    expect(presentCrewHandoffWait(thread(failed, "2026-10-30T09:30:00.000Z"))).toMatchObject({
      kind: "failed",
      title: "Builder failed",
      detail: "Tests timed out",
      handoffIds: ["h1"],
    });
    expect(presentCrewHandoffWait(thread(failed, "2026-10-30T10:05:00.000Z"))).toBeNull();
    expect(presentCrewHandoffWait(thread([]))).toBeNull();
  });

  it("names what holds the work up at the end of the chain", () => {
    const pm = thread([handoff({ id: "h1" })]);
    const threads = new Map<ThreadId, CrewHandoffThread>([
      [builderThread, thread([toDesigner])],
      [designerThread, thread([handoff({ id: "h3", member: "QA", threadId: qaThread })])],
    ]);
    expect(presentCrewHandoffWait(pm, (id) => threads.get(id) ?? null)).toMatchObject({
      title: "Waiting on Builder",
      detail: "Designer is waiting on QA",
      threadId: builderThread,
      blockedBy: { kind: "waiting", member: "QA", threadId: qaThread },
    });

    threads.set(designerThread, thread([]));
    threads.set(builderThread, thread([{ ...toDesigner, status: "needs-input", question: "?" }]));
    expect(presentCrewHandoffWait(pm, (id) => threads.get(id) ?? null)).toMatchObject({
      detail: "Designer asked Builder a question",
      blockedBy: { kind: "question", member: "Designer", threadId: designerThread },
    });

    threads.set(builderThread, thread([{ ...toDesigner, status: "failed", error: "Boom" }]));
    expect(presentCrewHandoffWait(pm, (id) => threads.get(id) ?? null)).toMatchObject({
      detail: "Designer failed",
      blockedBy: { kind: "failed", member: "Designer" },
    });
  });

  it("stops following a chain that loops back", () => {
    const pm = thread([handoff({ id: "h1" })]);
    const loop = thread([handoff({ id: "h2" })]);
    expect(presentCrewHandoffWait(pm, () => loop)?.title).toBe("Waiting on Builder");
  });
});

describe("crewHandoffRowLabel", () => {
  it("names who a row waits on and leaves failures to the thread", () => {
    expect(crewHandoffRowLabel([handoff({ id: "h1" })])).toBe("Builder");
    expect(crewHandoffRowLabel([handoff({ id: "h1" }), toDesigner])).toBe("Builder +1");
    expect(crewHandoffRowLabel([handoff({ id: "h1", status: "needs-input" })])).toBe(
      "Builder asked",
    );
    expect(crewHandoffRowLabel([handoff({ id: "h1", status: "failed" })])).toBeNull();
    expect(crewHandoffRowLabel(undefined)).toBeNull();
  });
});
