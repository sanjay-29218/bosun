import {
  ThreadId,
  type WorkflowDefinition,
  type WorkflowStageHandoff,
  type WorkflowStepEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectNotes,
  collectStageOutputs,
  latestStageResults,
  renderStageHandoff,
  selectReceived,
} from "./StageHandoff.ts";

const event = (
  fields: Partial<WorkflowStepEvent> & Pick<WorkflowStepEvent, "id" | "stepId" | "kind">,
): WorkflowStepEvent => ({
  executionId: null,
  runId: null,
  outcome: null,
  sourceKind: null,
  sourceId: null,
  actorId: "bot",
  detail: null,
  occurredAt: "2026-10-09T00:00:00Z",
  ...fields,
});
const start = (id: string, stepId: string, executionId: string, runId: string) =>
  event({ id, stepId, kind: "started", executionId, runId, sourceKind: "handoff" });
const complete = (id: string, stepId: string, executionId: string, outcome: string) =>
  event({ id, stepId, kind: "completed", executionId, outcome, detail: `${stepId} ${outcome}` });

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "delivery",
  name: "Delivery",
  revision: 3,
  start: "plan",
  roles: { builder: { roleId: "role:builder", roleRevision: 1, supervisor: null } },
  steps: {
    plan: {
      type: "task",
      role: "builder",
      task: "Plan",
      next: { ready: "design" },
      outputs: ["plan.md"],
    },
    design: {
      type: "task",
      role: "builder",
      task: "Design",
      next: { ready: "build" },
      outputs: ["design.md"],
    },
    build: {
      type: "task",
      role: "builder",
      task: "Build",
      next: { built: "end" },
      receives: { files: ["design.md"], diffs: [] },
    },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 2,
    maxStepExecutions: 10,
  },
};

const history = [
  start("s1", "plan", "e1", "run-plan"),
  complete("c1", "plan", "e1", "ready"),
  start("s2", "design", "e2", "run-design"),
  complete("c2", "design", "e2", "ready"),
  event({
    id: "note",
    stepId: "design",
    kind: "retry",
    executionId: "e2",
    sourceKind: "decision",
    actorId: "person",
    detail: "Keep the picker inside the model menu.",
  }),
];

describe("stage handoffs", () => {
  it("gives a stage what its definition receives, at the newest version", () => {
    const outputs = collectStageOutputs(
      definition,
      latestStageResults(history),
      new Map([
        ["run-plan", ThreadId.make("thread-plan")],
        ["run-design", ThreadId.make("thread-design")],
      ]),
      new Map([
        [
          ThreadId.make("thread-design"),
          { turnCount: 1, fromRef: "a", toRef: "b", additions: 4, deletions: 1, fileCount: 1 },
        ],
      ]),
    );
    expect(outputs.map((output) => [output.kind, output.stepId])).toEqual([
      ["file", "plan"],
      ["file", "design"],
      ["diff", "design"],
    ]);
    expect(selectReceived(definition, "design", outputs)).toBe(outputs);
    expect(selectReceived(definition, "build", outputs)).toEqual([
      expect.objectContaining({ kind: "file", path: "design.md", version: 1 }),
    ]);
  });

  it("carries the routing summary and people's decision notes, not a stage's answers", () => {
    const answered = event({
      id: "answer",
      stepId: "design",
      kind: "answered",
      executionId: "e2",
      sourceKind: "decision",
      detail: "Use the current API",
    });
    const { from, notes } = collectNotes(
      [...history, answered, start("s3", "build", "e3", "r")],
      "e3",
    );
    expect(from).toEqual({ stepId: "design", outcome: "ready" });
    expect(notes.map((note) => [note.kind, note.text])).toEqual([
      ["routed", "design ready"],
      ["decision", "Keep the picker inside the model menu."],
    ]);
    expect(collectNotes(history.slice(0, 1), "e1")).toEqual({ from: null, notes: [] });
  });

  it("carries a Request changes or Send back note into the rerun", () => {
    const requested = event({
      id: "changes",
      stepId: "design",
      kind: "changes-requested",
      executionId: "e2",
      actorId: "person",
      detail: "Split the settings into two sections.",
    });
    const rerun = collectNotes(
      [...history.slice(0, 4), requested, start("s3", "design", "e3", "r")],
      "e3",
    );
    expect(rerun.notes.map((note) => [note.kind, note.text])).toEqual([
      ["routed", "design ready"],
      ["decision", "Split the settings into two sections."],
    ]);

    const sentBack = event({
      id: "back",
      stepId: "build",
      kind: "sent-back",
      executionId: "e3",
      targetStepId: "design",
      actorId: "person",
      detail: "The design misses the empty state.",
    });
    const back = collectNotes(
      [
        ...history.slice(0, 4),
        start("s3", "build", "e3", "r"),
        sentBack,
        start("s4", "design", "e4", "r"),
      ],
      "e4",
    );
    expect(back.notes.map((note) => note.text)).toContain("The design misses the empty state.");
  });

  it("renders deterministically and fits a long brief by pointing at the full record", () => {
    const record: WorkflowStageHandoff = {
      id: "workflow:abc",
      featureId: "feature",
      stepId: "build",
      executionId: "e3",
      attempt: 1,
      workflow: { id: "delivery", name: "Delivery", revision: 3 },
      from: { stepId: "design", outcome: "ready" },
      brief: "Build a kanban board.",
      task: "Build",
      scope: "apps/web",
      outcomes: ["built"],
      produces: [],
      outputs: [
        {
          kind: "file",
          path: "design.md",
          stepId: "design",
          version: 2,
          threadId: null,
          exists: false,
        },
      ],
      notes: [],
      retry: null,
      workspace: { cwd: "/repo", branch: "crew/kanban", commit: "3f2a1c0deadbeef" },
      createdAt: "2026-10-09T00:00:00Z",
    };
    const short = renderStageHandoff(record);
    expect(renderStageHandoff(record)).toEqual(short);
    expect(short.taskText).toBe("Build");
    expect(short.contextText).toContain("design.md v2, from design (missing from the worktree)");
    expect(short.contextText).toContain("Worktree: /repo on crew/kanban @ 3f2a1c0deadb");
    expect(short.contextText).toContain("Scope: apps/web");
    expect(short.contextText).toContain("Brief:\nBuild a kanban board.");
    expect(short.contextText).not.toContain("crew_stage_handoff");

    const long = renderStageHandoff({ ...record, brief: "x".repeat(16_000) });
    expect(long.contextText.length).toBeLessThanOrEqual(4_000);
    expect(long.contextText).toContain("crew_stage_handoff");
    expect(long.contextText).toContain('{"outcome":"<one of: built>"');
  });
});
