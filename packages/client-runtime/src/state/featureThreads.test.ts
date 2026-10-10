import type { WorkflowDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeFeatureDraft } from "./featureThreads.ts";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "bug-fix",
  name: "Bug fix",
  revision: 1,
  start: "reproduce",
  bots: {
    builder: {
      template: { kind: "template", id: "template:builder", revision: 1 },
      supervisor: null,
    },
    qa: { template: { kind: "template", id: "template:qa", revision: 1 }, supervisor: null },
  },
  steps: {
    reproduce: { type: "task", bot: "builder", task: "Reproduce", next: { reproduced: "fix" } },
    fix: {
      type: "task",
      bot: "builder",
      task: "Fix",
      next: { needs_rework: "reproduce", fixed: "verify" },
      limits: { needs_rework: 2 },
      gate: true,
    },
    verify: { type: "task", bot: "qa", task: "Verify", next: { passed: "end", failed: "rework" } },
    rework: { type: "task", bot: "builder", task: "Rework", next: { done: "verify" } },
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 10 },
};

describe("makeFeatureDraft", () => {
  it("lists the stages on the forward path and previews the next one", () => {
    const roles = new Map([["template:qa", { name: "QA Tester", model: "Sonnet 5.5" }]]);
    const draft = makeFeatureDraft(definition, "fix", roles);
    // Rework is only reachable through a failure, so a thread can't start there.
    expect(draft.stages.map((stage) => stage.stepId)).toEqual(["reproduce", "fix", "verify"]);
    expect(draft.stage).toEqual({ stepId: "fix", label: "Fix", index: 2, total: 3 });
    // The forward route skips the limited rework loop.
    expect(draft.next).toEqual({
      label: "Verify",
      role: { name: "QA Tester", model: "Sonnet 5.5" },
      gated: true,
    });
    expect(makeFeatureDraft(definition, "verify").next).toBeNull();
    expect(makeFeatureDraft(definition, "rework").stage).toBeNull();
  });
});
