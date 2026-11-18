import { describe, expect, it } from "vite-plus/test";

import { relationshipRowStatus } from "./relationshipRowStatus.logic";

const runtime = (status: "running" | "idle" | "failed") =>
  ({ status, updatedAt: "2026-11-18T00:00:00.000Z" }) as never;
const shell = (fields: object = {}) => ({
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  runtime: runtime("idle"),
  ...fields,
});

describe("relationshipRowStatus", () => {
  it("reads Needs input for a parent waiting on the person, though its run is running", () => {
    expect(
      relationshipRowStatus({
        shell: shell({ hasPendingUserInput: true, runtime: runtime("running") }),
        featureLead: false,
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
        relationshipRowStatus({ shell: shell(asking), featureLead: true, runStatus: null }),
      ).toBe("needs_input");
    }
  });

  it("reads a running row as running", () => {
    expect(
      relationshipRowStatus({
        shell: shell({ runtime: runtime("running") }),
        featureLead: false,
        runStatus: "running",
      }),
    ).toBe("running");
    expect(
      relationshipRowStatus({
        shell: shell({ runtime: runtime("running") }),
        featureLead: true,
        runStatus: null,
      }),
    ).toBe("running");
  });

  it("reads a finished row by its run, and a feature lead that stopped as waiting", () => {
    expect(
      relationshipRowStatus({ shell: shell(), featureLead: false, runStatus: "completed" }),
    ).toBe("completed");
    expect(
      relationshipRowStatus({ shell: undefined, featureLead: false, runStatus: "failed" }),
    ).toBe("failed");
    expect(
      relationshipRowStatus({ shell: shell(), featureLead: true, runStatus: "completed" }),
    ).toBe("waiting");
    expect(
      relationshipRowStatus({
        shell: shell({ runtime: runtime("failed") }),
        featureLead: true,
        runStatus: null,
      }),
    ).toBe("failed");
  });
});
