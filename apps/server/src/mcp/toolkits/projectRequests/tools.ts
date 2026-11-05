import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { ProjectRequests } from "../../../crew/ProjectRequests.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FeatureService,
    ProjectRequests,
  ],
};

const RequestStatus = Schema.Literals(["open", "done"]);

const SendRequest = Tool.make("t3_project_send", {
  ...shared,
  description:
    "Hand a request to a project's Project manager, which runs that project's work: it picks a task, a feature or several, and replies to this thread as the work moves. key names the request for you: sending again with the same key returns the same request rather than a second one. Allowed from the headquarters of the bot that owns the project, or a full-access thread.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    message: Schema.String.annotate({
      description: "The request, with everything the Project manager needs to know.",
    }),
    key: Schema.String,
  }),
  success: Schema.Struct({
    requestId: Schema.String,
    projectId: ProjectId,
    managerThreadId: ThreadId,
    link: Schema.String,
  }),
}).annotate(Tool.Destructive, false);

const ListRequests = Tool.make("t3_project_requests", {
  ...shared,
  description:
    "List project requests: in a Project manager's thread, every request of its project; in any other thread, the ones it sent. status keeps open or done ones.",
  parameters: Schema.Struct({ status: Schema.optional(RequestStatus) }),
  success: Schema.Struct({
    requests: Schema.Array(
      Schema.Struct({
        requestId: Schema.String,
        projectId: ProjectId,
        requesterThreadId: ThreadId,
        text: Schema.String,
        issue: Schema.NullOr(Schema.String),
        status: RequestStatus,
        createdAt: Schema.String,
        closedAt: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

/** Listed to every caller; each handler checks who may use it. */
export const ProjectRequestsToolkit = Toolkit.make(SendRequest, ListRequests);

const ReplyToRequest = Tool.make("t3_project_reply", {
  ...shared,
  description:
    "Answer a request your project received, in the thread that sent it: when its work starts, when you need an answer, and when it is done. key names this reply: a retry with the same key isn't sent twice, so give each new reply a new key. issue records the issue or ticket (#12, T-3) that tracks the request. done: true closes the request once its work is done or won't be done.",
  parameters: Schema.Struct({
    requestId: Schema.String,
    message: Schema.String,
    key: Schema.String,
    issue: Schema.optional(Schema.String),
    done: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    requestId: Schema.String,
    status: RequestStatus,
    issue: Schema.NullOr(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

/** Only a project's manager replies, so it is listed to crew threads alone. */
export const ProjectReplyToolkit = Toolkit.make(ReplyToRequest);
