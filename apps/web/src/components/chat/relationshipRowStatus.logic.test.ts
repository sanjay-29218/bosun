import { describe, expect, it } from "vite-plus/test";

import { relationshipRowStatus, threadAsksPerson } from "./relationshipRowStatus.logic";

const runtime = (status: "running" | "idle" | "failed") =>
  ({ status, updatedAt: "2026-11-18T00:00:00.000Z" }) as never;
const lead = (fields: object = {}) => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: runtime("idle"),
  ...fields,
});
const request = (kind: string) => ({ pendingRuntimeRequest: { kind } }) as never;

describe("relationshipRowStatus", () => {
  it("reads Needs input for a parent waiting on the person, though its run is running", () => {
    expect(
      relationshipRowStatus({
        featureLead: undefined,
        asking: threadAsksPerson(request("user_input")),
        runStatus: "running",
      }),
    ).toBe("needs_input");
    expect(
      relationshipRowStatus({
        featureLead: undefined,
        asking: threadAsksPerson(request("command_execution_approval")),
        runStatus: "running",
      }),
    ).toBe("needs_input");
  });

  it("reads Needs input for a feature lead asking for an approval or an answer", () => {
    for (const asking of [
      { hasPendingApprovals: true },
      { pendingSubagentRequest: "approval" },
      { hasPendingUserInput: true },
      { pendingSubagentRequest: "user_input" },
    ]) {
      expect(
        relationshipRowStatus({ featureLead: lead(asking), asking: false, runStatus: null }),
      ).toBe("needs_input");
    }
  });

  it("reads a running row as running", () => {
    expect(
      relationshipRowStatus({ featureLead: undefined, asking: false, runStatus: "running" }),
    ).toBe("running");
    expect(
      relationshipRowStatus({
        featureLead: lead({ runtime: runtime("running") }),
        asking: false,
        runStatus: null,
      }),
    ).toBe("running");
  });

  it("reads a finished row by its run, and a feature lead that stopped as waiting", () => {
    expect(
      relationshipRowStatus({ featureLead: undefined, asking: false, runStatus: "completed" }),
    ).toBe("completed");
    expect(
      relationshipRowStatus({ featureLead: lead(), asking: false, runStatus: "completed" }),
    ).toBe("waiting");
    expect(
      relationshipRowStatus({
        featureLead: lead({ runtime: runtime("failed") }),
        asking: false,
        runStatus: null,
      }),
    ).toBe("failed");
  });
});

describe("relationshipRowStatus for a feature's lead", () => {
  it("reads a stopped lead as its feature does: Ready for review until merged, then Done", () => {
    const finished = lead({ runtime: null });
    const row = (featureStatus: "review" | "done" | "waiting" | null) =>
      relationshipRowStatus({
        featureLead: finished,
        featureStatus,
        asking: false,
        runStatus: null,
      });
    expect(row("review")).toBe("ready_for_review");
    expect(row("done")).toBe("completed");
    expect(row("waiting")).toBe("waiting");
    // Before its board card loads, it never claims Done.
    expect(row(null)).toBe("waiting");
  });
});

describe("threadAsksPerson", () => {
  it("counts approvals and questions, not an auth refresh or a thread with none", () => {
    expect(threadAsksPerson(request("user_input"))).toBe(true);
    expect(threadAsksPerson(request("auth_refresh"))).toBe(false);
    expect(threadAsksPerson({ pendingRuntimeRequest: null })).toBe(false);
    // Thread records from older servers or partial reads may leave the field out.
    expect(threadAsksPerson({} as never)).toBe(false);
    expect(threadAsksPerson(null)).toBe(false);
  });
});
