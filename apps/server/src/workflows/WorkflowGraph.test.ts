import { WorkflowDefinition, type WorkflowStep } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { readyWorkflowSteps, validateWorkflowDefinition } from "./WorkflowGraph.ts";

const steps: ReadonlyArray<WorkflowStep> = [
  { id: "plan", kind: "bot", templateId: "custom-planner", completion: "handoff", dependsOn: [] },
  { id: "design", kind: "bot", templateId: "design", completion: "handoff", dependsOn: [] },
  {
    id: "build",
    kind: "bot",
    templateId: "builder",
    completion: "handoff",
    dependsOn: ["plan", "design"],
  },
  {
    id: "review",
    kind: "decision",
    approver: { kind: "bot", templateId: "independent-reviewer" },
    dependsOn: ["build"],
  },
  { id: "end", kind: "end", dependsOn: ["review"] },
];

const definition = (items: ReadonlyArray<WorkflowStep> = steps) => ({
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 1,
  steps: items,
});

describe("workflow graph", () => {
  it("makes independent work ready together and advances through an explicit decision", () => {
    expect(readyWorkflowSteps(definition(), new Set()).map((step) => step.id)).toEqual([
      "design",
      "plan",
    ]);
    expect(readyWorkflowSteps(definition(), new Set(["plan"])).map((step) => step.id)).toEqual([
      "design",
    ]);
    expect(
      readyWorkflowSteps(definition(), new Set(["plan", "design"])).map((step) => step.id),
    ).toEqual(["build"]);
    expect(
      readyWorkflowSteps(definition(), new Set(["plan", "design", "build"])).map((step) => step.id),
    ).toEqual(["review"]);
    expect(
      readyWorkflowSteps(definition(), new Set(["plan", "design", "build", "review"])).map(
        (step) => step.id,
      ),
    ).toEqual(["end"]);
    expect(
      readyWorkflowSteps(definition(), new Set(["plan", "design", "build", "review", "end"])),
    ).toEqual([]);
  });

  it("produces the same dependency order regardless of the stored step order", () => {
    const expected = validateWorkflowDefinition(definition()).map((step) => step.id);
    expect(
      validateWorkflowDefinition(definition(steps.toReversed())).map((step) => step.id),
    ).toEqual(expected);
  });

  it("rejects missing, duplicate, cyclic, and orphaned work", () => {
    const changes: Array<[ReadonlyArray<WorkflowStep>, RegExp]> = [
      [[...steps, steps[0]!], /Duplicate step ID/],
      [
        [...steps.slice(0, 4), { id: "end", kind: "end", dependsOn: ["absent"] }],
        /Unknown dependency/,
      ],
      [
        [
          { id: "a", kind: "bot", templateId: "a", completion: "handoff", dependsOn: ["b"] },
          { id: "b", kind: "bot", templateId: "b", completion: "handoff", dependsOn: ["a"] },
          { id: "end", kind: "end", dependsOn: ["a"] },
        ],
        /dependency cycle/,
      ],
      [
        [
          ...steps,
          { id: "orphan", kind: "bot", templateId: "x", completion: "handoff", dependsOn: [] },
        ],
        /lead to the end/,
      ],
      [[...steps, { id: "another_end", kind: "end", dependsOn: ["review"] }], /exactly one end/],
    ];
    for (const [items, error] of changes) {
      expect(() => validateWorkflowDefinition(definition(items))).toThrow(error);
    }
  });

  it("rejects invalid selectors and completion history", () => {
    const badBot = steps.map((step) =>
      step.id === "build" && step.kind === "bot" ? { ...step, templateId: " " } : step,
    );
    expect(() => validateWorkflowDefinition(definition(badBot))).toThrow(/needs a template/);
    expect(() => readyWorkflowSteps(definition(), new Set(["unknown"]))).toThrow(
      /Unknown completed step/,
    );
    expect(() => readyWorkflowSteps(definition(), new Set(["build"]))).toThrow(
      /incomplete dependencies/,
    );
  });

  it("rejects unsupported step kinds and bot completion modes at the contract boundary", () => {
    const decode = Schema.decodeUnknownSync(WorkflowDefinition);
    expect(() => decode(definition())).not.toThrow();
    expect(() =>
      decode({
        ...definition(),
        steps: [
          { id: "run", kind: "script", dependsOn: [] },
          { id: "end", kind: "end", dependsOn: ["run"] },
        ],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...definition(),
        steps: [
          {
            id: "run",
            kind: "bot",
            templateId: "builder",
            completion: "turn-ended",
            dependsOn: [],
          },
          { id: "end", kind: "end", dependsOn: ["run"] },
        ],
      }),
    ).toThrow();
  });
});
