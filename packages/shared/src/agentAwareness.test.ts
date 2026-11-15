import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2, subagentAwaitsUser } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "latestRunBackgroundWake"
        | "latestRunStopRequested"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "settledOverride"
        | "feature"
        | "latestRunId"
        | "latestRunQuietWake"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt,
    ...overrides,
  });

  it("does not announce completion after a manual stop", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
    };
    expect(projectThreadAwarenessV2(input)?.phase).toBe("completed");
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: { ...input.thread, latestRunStopRequested: true },
      }),
    ).toBeNull();
  });

  it.each([
    ["holds a wake run", true, [{ taskId: "watch", kind: "monitor" as const }], "running"],
    ["completes a wake run once its monitor ends", true, [], "completed"],
    [
      "holds a wake run while a monitor remains beside other work",
      true,
      [
        { taskId: "build", kind: "command" as const },
        { taskId: "watch", kind: "monitor" as const },
      ],
      "running",
    ],
    [
      "completes a wake run with only a command pending",
      true,
      [{ taskId: "build", kind: "command" as const }],
      "completed",
    ],
    [
      "completes a run the user started",
      false,
      [{ taskId: "watch", kind: "monitor" as const }],
      "completed",
    ],
  ] as const)("%s while a monitor wakes the thread", (_, latestRunBackgroundWake, tasks, phase) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [...tasks],
        }),
      })?.phase,
    ).toBe(phase);
  });

  it.each([
    ["running", "subagent"],
    ["completed", "subagent"],
    ["failed", "subagent"],
    ["running", "side chat"],
  ] as const)("does not publish %s %s activity", (status, kind) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status,
          lineage: {
            rootThreadId: "parent" as ThreadId,
            parentThreadId: "parent" as ThreadId,
            ...(kind === "subagent"
              ? { relationshipToParent: "subagent" }
              : { relationshipToParent: "fork", sideChat: true }),
          },
        }),
      }),
    ).toBeNull();
  });

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["completed", "completed", false],
    ["failed", "failed", false],
    ["monitor-held", "completed", true],
  ] as const)("removes settled %s work", (_, status, latestRunBackgroundWake) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status,
          settledOverride: "settled",
          latestRunBackgroundWake,
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
        }),
      }),
    ).toBeNull();
  });

  it.each(["starting", "running", "waiting"] as const)(
    "keeps settled %s work visible",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({ status, settledOverride: "settled" }),
        }),
      ).toMatchObject({ phase: status === "starting" ? "starting" : "running" });
    },
  );

  it.each(["user_input", "command"] as const)(
    "keeps a settled terminal thread with a pending %s request",
    (kind) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status: "completed",
            settledOverride: "settled",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-settled"),
              kind,
              createdAt: updatedAt,
            },
          }),
        }),
      ).toMatchObject({
        phase: kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
      });
    },
  );

  it("keeps settled work held open by an awaited monitor", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          settledOverride: "settled",
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
        }),
      }),
    ).toMatchObject({ phase: "running" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a dev server's watchdog monitor", "completed", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a command the agent waits on",
      "running",
      [{ taskId: "tests", kind: "command", awaited: true }],
    ],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("reports an async question as input while the run keeps working", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-async"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: false,
        },
      }),
    };
    expect(projectThreadAwarenessV2(input)).toMatchObject({
      phase: "waiting_for_input",
      headline: "Waiting for input",
    });
  });

  it("opens the asking crew member's thread, whose ask waits on the person after its turn", () => {
    const crewThreadId = "thread-designer" as ThreadId;
    const asked = {
      id: RuntimeRequestId.make("request-crew-ask"),
      kind: "user_input" as const,
      createdAt: updatedAt,
      blocking: false,
      userOnly: true,
    };
    // The member's turn has ended, yet its question still waits on the person.
    expect(
      subagentAwaitsUser({
        creationSource: "mcp",
        lineage: {
          rootThreadId: "thread-2" as ThreadId,
          parentThreadId: "thread-2" as ThreadId,
          relationshipToParent: "subagent",
        },
        activityRunStatus: null,
        pendingRuntimeRequest: asked,
      }),
    ).toBe(true);
    const lead = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
      pendingSubagentRequest: {
        requestId: asked.id,
        updatedAt,
        waitsForInput: true,
        threadId: crewThreadId,
      },
    };
    const awareness = projectThreadAwarenessV2(lead);
    expect(awareness?.phase).toBe("waiting_for_input");
    expect(awareness?.deepLink).toContain(encodeURIComponent(crewThreadId));
    // The lead's own question opens the lead.
    expect(
      projectThreadAwarenessV2({
        ...lead,
        thread: v2Thread({ pendingRuntimeRequest: { ...asked, id: RuntimeRequestId.make("own") } }),
      })?.deepLink,
    ).not.toContain(encodeURIComponent(crewThreadId));
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });
});

describe("feature completion notifications", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const leadId = "lead" as ThreadId;
  const runId = "run-2" as RunId;
  const feature = { id: "feature-1", title: "Checkout" };
  const lineage = { rootThreadId: leadId, parentThreadId: null, relationshipToParent: null };
  const thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        "feature" | "latestRunId" | "latestRunQuietWake" | "lineage" | "pendingRuntimeRequest"
      >
    > = {},
  ) => ({
    id: leadId,
    lineage,
    title: "Checkout",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "completed" as const,
    latestRunId: runId,
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt,
    ...overrides,
  });
  const question = {
    id: RuntimeRequestId.make("question"),
    kind: "user_input" as const,
    createdAt: updatedAt,
  };

  it.each([
    ["a plain thread finishing", thread(), false, null, "completed"],
    [
      "a crew member's turn ending",
      thread({
        feature: { ...feature, member: "Builder" },
        lineage: {
          rootThreadId: leadId,
          parentThreadId: leadId,
          relationshipToParent: "subagent",
          listed: true,
        },
      }),
      false,
      null,
      null,
    ],
    ["the lead handing work to its crew", thread({ feature }), true, null, null],
    // The server reads a child feature that hasn't reported as working (crewWorkingShellThread).
    [
      "the parent lead while a child feature it started works",
      thread({ feature }),
      true,
      null,
      null,
    ],
    ["the lead stopping with its crew idle", thread({ feature }), false, null, "completed"],
    [
      "the lead stopping before its shell names a run",
      thread({ feature, latestRunId: null }),
      false,
      null,
      "completed",
    ],
    [
      "a child feature's lead in the run that reported it finished",
      thread({ feature: { ...feature, parentFeatureId: "parent", finishedRunId: runId } }),
      false,
      null,
      null,
    ],
    [
      "a child feature's lead stopping in a later run",
      thread({ feature: { ...feature, parentFeatureId: "parent", finishedRunId: "run-1" } }),
      false,
      null,
      "completed",
    ],
    [
      "the requester's turn answering the feature's finished report",
      thread({ latestRunQuietWake: true }),
      false,
      null,
      null,
    ],
    [
      "a crew member asking the person while the lead waits",
      thread({ feature }),
      true,
      { requestId: question.id, updatedAt, threadId: "crew" as ThreadId },
      "waiting_for_approval",
    ],
    [
      "the lead asking the person while its crew works",
      thread({ feature, pendingRuntimeRequest: question }),
      true,
      null,
      "waiting_for_input",
    ],
  ] as const)("%s", (_, input, crewWorking, pendingSubagentRequest, phase) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: { ...input, crewWorking },
        pendingSubagentRequest,
      })?.phase ?? null,
    ).toBe(phase);
  });
});
