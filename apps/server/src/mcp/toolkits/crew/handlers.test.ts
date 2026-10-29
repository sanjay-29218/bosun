import { expect, it } from "@effect/vitest";
import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  EnvironmentId,
  IssueOperationError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type IssueList,
  type Ticket,
  type WorkflowStageHandoff,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotProjects } from "../../../bots/BotProjects.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as IssueService from "../../../issues/IssueService.ts";
import { TicketService } from "../../../tickets/TicketService.ts";
import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore, type CrewHandoff } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore, type CrewRun } from "../../../crew/CrewStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CrewHandlers from "./handlers.ts";
import { CrewToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:bots");
const stageThread = ThreadId.make("bot-run:stage");
const record: WorkflowStageHandoff = {
  id: "workflow:stage",
  featureId: "feature",
  stepId: "build",
  executionId: "execution",
  attempt: 1,
  workflow: { id: "delivery", name: "Delivery", revision: 2 },
  from: { stepId: "design", outcome: "ready" },
  brief: "Build the board",
  task: "Build",
  scope: null,
  outcomes: ["built"],
  produces: [],
  outputs: [],
  notes: [],
  retry: null,
  workspace: { cwd: "/repo", branch: null, commit: null },
  createdAt: "2026-10-09T00:00:00Z",
};

const issueList: IssueList = {
  repository: "acme/web",
  unavailable: null,
  truncated: false,
  readAt: "2026-10-09T00:00:00Z",
  milestones: [],
  issues: [
    {
      number: 1,
      title: "Board",
      url: "https://github.com/acme/web/issues/1",
      state: "open",
      updatedAt: "2026-10-09T00:00:00Z",
      closedAt: null,
      milestone: { number: 2, title: "v1" },
      parent: null,
      subIssues: { completed: 1, total: 3 },
      labels: [{ name: "feature", color: "0e8a16" }],
      assignees: [{ login: "octo", avatarUrl: "https://avatars/octo" }],
    },
    {
      number: 4,
      title: "Card",
      url: "https://github.com/acme/web/issues/4",
      state: "open",
      updatedAt: "2026-10-08T00:00:00Z",
      closedAt: null,
      milestone: null,
      parent: 1,
      subIssues: null,
      labels: [],
      assignees: [],
    },
    {
      number: 3,
      title: "Column",
      url: "https://github.com/acme/web/issues/3",
      state: "closed",
      updatedAt: "2026-10-07T00:00:00Z",
      closedAt: "2026-10-07T00:00:00Z",
      milestone: { number: 2, title: "v1" },
      parent: 1,
      subIssues: null,
      labels: [],
      assignees: [],
    },
  ],
};

const ticket: Ticket = {
  id: "ticket:1",
  projectId,
  number: 3,
  title: "Sketch the board",
  description: "",
  state: "open",
  closedReason: null,
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
  closedAt: null,
};

const handoff = (id: string, targetMemberId: string): CrewHandoff =>
  ({
    id,
    parentId: null,
    sourceRunId: "bot-hq:bot-captain",
    targetMemberId,
    targetRunId: `bot-handoff:${id}`,
    projectId,
    taskText: "Fix it",
    contextText: "",
    depth: 1,
    status: "running",
    responseText: null,
    questionText: null,
    lastError: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  }) as CrewHandoff;

const handleAs = (threadId: ThreadId, allowedTools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const toolkit = yield* CrewToolkit;
    return yield* toolkit.handle("crew_stage_handoff", {}).pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(Effect.provide(layerAs(threadId, allowedTools)));

const layerAs = (threadId: ThreadId, allowedTools: ReadonlyArray<string>) =>
  McpToolAccess.HandlersLayer.layer(CrewHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:bots"),
          requestNamespace: "provider:bots",
          thread: {
            threadId,
            providerSessionId: "provider:bots",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["crew" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), projectId }),
        }),
        Layer.mock(CrewHandoffService)({
          delegate: (input) => Effect.succeed(handoff(input.id, input.targetMemberId)),
        }),
        Layer.mock(BotProjects)({}),
        Layer.mock(FeatureService)({}),
        Layer.mock(CrewHandoffStore)({
          getRunByThread: (id) => Effect.succeed(id === stageThread ? "run:stage" : null),
          get: (id) =>
            Effect.succeed(id === "earlier" ? handoff(id, `bot-manager:${projectId}`) : null),
        }),
        Layer.mock(CrewStore)({
          getRun: () =>
            Effect.succeed({ id: "run:stage", projectId, allowedTools } as unknown as CrewRun),
        }),
        Layer.mock(WorkflowService)({
          getStageHandoffForThread: (project, thread) =>
            Effect.succeed(project === projectId && thread === stageThread ? record : null),
        }),
        Layer.mock(IssueService.IssueService)({
          list: (project) =>
            project === projectId
              ? Effect.succeed(issueList)
              : Effect.fail(new IssueOperationError({ reason: "Project not found." })),
        }),
        Layer.mock(TicketService)({
          list: () => Effect.succeed([ticket]),
          getByNumber: (_project, number) =>
            number === ticket.number
              ? Effect.succeed(ticket)
              : Effect.die(`unexpected ticket ${number}`),
        }),
      ),
    ),
  );

it.effect("lets a stage member read the handoff its stage started from", () =>
  Effect.gen(function* () {
    const read = yield* handleAs(stageThread, ["crew.respond"]);
    expect(read.at(-1)?.result).toEqual(record);

    const ungranted = yield* Effect.flip(handleAs(stageThread, ["crew.delegate"]));
    expect(ungranted).toMatchObject({ _tag: "CrewToolFailedError" });
    expect(ungranted.message).toContain("Caller is not a workflow stage member");

    const plainThread = yield* Effect.flip(handleAs(ThreadId.make("thread:plain"), []));
    expect(plainThread.message).toContain("Caller is not a workflow stage member");
  }),
);

it.effect("sends a bot's work for a project through t3_feature_start", () =>
  Effect.gen(function* () {
    const delegate = (requestId: string, targetMemberId: string) =>
      Effect.gen(function* () {
        const toolkit = yield* CrewToolkit;
        return yield* toolkit
          .handle("crew_delegate", { requestId, targetMemberId, taskText: "Fix it" })
          .pipe(Stream.unwrap, Stream.runCollect);
      }).pipe(Effect.provide(layerAs(botHeadquartersThreadId(CAPTAIN_BOT_ID), ["crew.delegate"])));

    const refused = yield* Effect.flip(delegate("new", `bot-manager:${projectId}`));
    expect(refused.message).toContain("t3_feature_start");
    // A request made before still answers its retry, and the rest of the crew is reached as before.
    expect((yield* delegate("earlier", `bot-manager:${projectId}`)).at(-1)?.result).toMatchObject({
      id: "earlier",
    });
    expect((yield* delegate("build", `bot-builder:${projectId}`)).at(-1)?.result).toMatchObject({
      id: "build",
    });
  }),
);

it.effect("lists the issues of the calling thread's project as compact rows", () =>
  Effect.gen(function* () {
    const toolkit = yield* CrewToolkit;
    const call = (params: {
      readonly state?: "open" | "closed" | "all";
      readonly milestone?: string;
      readonly limit?: number;
    }) =>
      toolkit.handle("crew_list_issues", params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.flatMap((chunks) => {
          const result = chunks.at(-1)?.result;
          return result !== undefined && "issues" in result
            ? Effect.succeed(result)
            : Effect.die(result);
        }),
      );

    const open = yield* call({});
    expect(open).toMatchObject({ repository: "acme/web", unavailable: null, truncated: false });
    expect(open.issues).toEqual([
      {
        number: 1,
        title: "Board",
        url: "https://github.com/acme/web/issues/1",
        state: "open",
        milestone: "v1",
        parent: null,
        subIssues: { completed: 1, total: 3 },
        labels: ["feature"],
        assignees: ["octo"],
      },
      expect.objectContaining({ number: 4, milestone: null, parent: 1 }),
    ]);

    expect(open.tickets).toEqual([{ ref: "T-3", title: "Sketch the board", state: "open" }]);

    const v1 = yield* call({ state: "all", milestone: "V1" });
    expect(v1.issues.map((issue) => issue.number)).toEqual([1, 3]);
    // Tickets have no milestone, so a milestone filter leaves none.
    expect(v1.tickets).toEqual([]);

    const first = yield* call({ state: "all", limit: 1 });
    expect(first.issues.map((issue) => issue.number)).toEqual([1]);
  }).pipe(Effect.provide(layerAs(stageThread, []))),
);

it.effect("reads a todo as a ticket for T-<number> and refuses an unnamed one", () =>
  Effect.gen(function* () {
    const toolkit = yield* CrewToolkit;
    const read = (ref: string) =>
      toolkit.handle("crew_read_todo", { ref }).pipe(Stream.unwrap, Stream.runCollect);

    const found = yield* read("t-3");
    expect(found.at(-1)?.result).toEqual({ kind: "ticket", ticket });

    const unnamed = yield* Effect.flip(read("the board one"));
    expect(unnamed.message).toContain("T-<number>");
  }).pipe(Effect.provide(layerAs(stageThread, []))),
);
