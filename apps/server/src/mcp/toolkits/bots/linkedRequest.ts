import {
  type EnvironmentId,
  headquartersBotId,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";

import { TASK_BRIEF } from "../../../crew/crewPrompts.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * From a bot's headquarters: a request for its project on linked environment `environmentId`,
 * as a task of that project's Feature manager there. It starts there now, or waits for that
 * environment and starts once it answers; its reply comes back to this thread either way.
 */
export const sendToLinkedProject = Effect.fn("BotsToolkit.sendToLinkedProject")(function* (
  operation: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title?: string | undefined;
    readonly request: string;
    readonly key: string;
  },
) {
  const scope = yield* McpInvocationContext.requireThreadScope(
    yield* McpInvocationContext.McpInvocationContext,
    operation,
  );
  if (headquartersBotId(scope.thread.threadId) === null) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Only a bot's headquarters sends work to its project on a linked environment. Leave out environmentId for a project here.",
    });
  }
  const { taskId } = yield* (yield* RemoteDelegation.RemoteDelegation).delegate(scope, {
    task: `${TASK_BRIEF}\n\n${input.request}`,
    ...(input.title === undefined ? {} : { title: input.title }),
    target: { environmentId: input.environmentId, projectId: input.projectId },
    isolation: "worktree",
    mode: "async",
    clientRequestId: input.key,
  });
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const { subagents } = yield* threads
    .getThreadRecords(scope.thread.threadId, ["subagents"], { subagentIds: [taskId] })
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message:
              "The request was sent, but its task could not be read; t3_bot_projects shows it.",
          }),
      ),
    );
  const remote = subagents[0]?.remoteChild;
  return {
    taskId,
    threadId: remote?.threadId ?? null,
    link: remote === undefined ? null : formatThreadLink(remote, remote.title),
    waiting: remote === undefined ? (subagents[0]?.progress ?? null) : null,
  };
});
