import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  projectHeadquartersThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectRequestsHandlers from "./handlers.ts";
import { ProjectRequestsToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:web");

/** Sends a request as `threadId`, at `runtimeMode`, and says who the service heard from. */
const sendAs = (threadId: ThreadId, runtimeMode: RuntimeMode = "approval-required") =>
  Effect.gen(function* () {
    const senders = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = McpToolAccess.HandlersLayer.layer(ProjectRequestsHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:web"),
            requestNamespace: "provider:web",
            thread: {
              threadId,
              providerSessionId: "provider:web",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set(["orchestration" as const]),
            issuedAt: 0,
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { runtimeMode })),
          }),
          Layer.mock(FeatureService)({
            projectBot: (project) => Effect.succeed(project === projectId ? "bot-social" : null),
          }),
          Layer.mock(ProjectRequests)({
            send: (input) =>
              Ref.update(senders, (all) => [...all, input.requesterThreadId]).pipe(
                Effect.as({
                  request: { id: "R-1", projectId } as never,
                  managerThreadId: projectHeadquartersThreadId(projectId),
                }),
              ),
          }),
        ),
      ),
    );
    const chunks = yield* Effect.gen(function* () {
      const toolkit = yield* ProjectRequestsToolkit;
      return yield* toolkit
        .handle("t3_project_send", { projectId, message: "Add CSV export", key: "csv" })
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(Effect.provide(layer));
    return { said: JSON.stringify(chunks.at(-1)?.result), senders: yield* Ref.get(senders) };
  });

it.effect("lets the owning bot's headquarters or a full-access thread send a request", () =>
  Effect.gen(function* () {
    const owner = ThreadId.make("bot-run:bot-hq:bot-social");
    const person = ThreadId.make("thread:person");
    expect((yield* sendAs(owner)).senders).toEqual([owner]);
    expect((yield* sendAs(person, "full-access")).senders).toEqual([person]);

    for (const refused of [
      yield* sendAs(ThreadId.make("bot-run:bot-hq:bot-other")),
      yield* sendAs(person),
    ]) {
      expect(refused.senders).toEqual([]);
      expect(refused.said).toContain("the headquarters of the bot that owns the project");
    }
  }),
);
