import {
  type EnvironmentId,
  headquartersBotId,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectRequests, type ProjectRequest } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { sendToLinkedProject } from "../bots/linkedRequest.ts";
import { fullAccessCaller } from "../features/access.ts";
import { ProjectRequestsToolkit } from "./tools.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const asMcpFailure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      });

const view = (request: ProjectRequest) => ({
  requestId: request.id,
  projectId: request.projectId,
  requesterThreadId: request.requesterThreadId,
  text: request.text,
  issue: request.issueRef,
  status: request.status,
});

/** The thread that hears back: a subagent's top thread, since the subagent has already ended. */
const requesterThread = Effect.fn("ProjectRequestsToolkit.requesterThread")(function* (
  operation: string,
) {
  const scope = yield* McpInvocationContext.requireThreadScope(
    yield* McpInvocationContext.McpInvocationContext,
    operation,
  );
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads.getThreadShell(scope.thread.threadId);
  return {
    scope,
    threadId:
      shell?.lineage.relationshipToParent === "subagent"
        ? shell.lineage.rootThreadId
        : scope.thread.threadId,
  };
});

export const layer = McpToolAccess.toLayer(ProjectRequestsToolkit, {
  t3_project_send: McpToolAccess.actsAsCaller(
    (input: {
      readonly environmentId?: EnvironmentId | undefined;
      readonly projectId: ProjectId;
      readonly message: string;
      readonly key: string;
    }) =>
      Effect.gen(function* () {
        const { scope, threadId } = yield* requesterThread("t3_project_send");
        const environmentId = PeerForwarding.remoteTarget(scope, input.environmentId);
        if (environmentId !== undefined) {
          const sent = yield* sendToLinkedProject("t3_project_send", {
            environmentId,
            projectId: input.projectId,
            request: input.message,
            key: input.key,
          });
          return {
            requestId: sent.taskId,
            managerThreadId: sent.threadId,
            link: sent.link,
            ...(sent.waiting === null ? {} : { waiting: sent.waiting }),
          };
        }
        const features = yield* FeatureService;
        // A bot's headquarters sends to the projects its bot owns; anyone else needs full access.
        const botId = headquartersBotId(scope.thread.threadId);
        if (botId === null || (yield* features.projectBot(input.projectId)) !== botId) {
          yield* fullAccessCaller(
            "Sending a project's manager a request needs the headquarters of the bot that owns the project, or a live full-access/default calling thread.",
          );
        }
        const requests = yield* ProjectRequests;
        const { request, managerThreadId } = yield* requests.send({
          projectId: input.projectId,
          requesterThreadId: threadId,
          key: input.key,
          message: input.message,
        });
        return {
          requestId: request.id,
          managerThreadId,
          link: McpInvocationContext.threadLinkFor(scope, managerThreadId),
        };
      }).pipe(Effect.mapError(asMcpFailure)),
  ),
  t3_project_requests: McpToolAccess.readsAsCaller(
    (input: { readonly status?: "open" | "done" | undefined }) =>
      Effect.gen(function* () {
        const { threadId } = yield* requesterThread("t3_project_requests");
        const requests = yield* ProjectRequests;
        const listed = yield* requests.list({
          callerThreadId: threadId,
          ...(input.status === undefined ? {} : { status: input.status }),
        });
        return { requests: listed.map(view) };
      }).pipe(Effect.mapError(asMcpFailure)),
  ),
  t3_project_reply: McpToolAccess.actsAsCaller(
    (input: {
      readonly requestId: string;
      readonly message: string;
      readonly key: string;
      readonly issue?: string | undefined;
      readonly done?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireThreadScope(
          yield* McpInvocationContext.McpInvocationContext,
          "t3_project_reply",
        );
        const requests = yield* ProjectRequests;
        const request = yield* requests.reply({
          managerThreadId: scope.thread.threadId,
          requestId: input.requestId.trim(),
          key: input.key,
          message: input.message,
          issue: input.issue,
          done: input.done,
        });
        return { requestId: request.id, status: request.status, issue: request.issueRef };
      }).pipe(Effect.mapError(asMcpFailure)),
  ),
});
