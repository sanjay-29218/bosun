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
    "Send a project's manager a request; it replies in this thread. The same key returns the same request. Needs the owning bot's headquarters or full access.",
  parameters: Schema.Struct({ projectId: ProjectId, message: Schema.String, key: Schema.String }),
  success: Schema.Struct({
    requestId: Schema.String,
    managerThreadId: ThreadId,
    link: Schema.String,
  }),
}).annotate(Tool.Destructive, false);

const ListRequests = Tool.make("t3_project_requests", {
  ...shared,
  description: "List requests: a manager sees its project's, other threads their own.",
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
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ReplyToRequest = Tool.make("t3_project_reply", {
  ...shared,
  description:
    "Answer a request in the thread that sent it: when its work starts, when you need an answer, and when it is done. Give each reply a new key; a retry with the same key isn't sent twice. issue records the issue or ticket (#12, T-3) tracking it. done: true closes it once its work is done or dropped.",
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

/** Listed to crew threads; each handler checks who may use it. */
export const ProjectRequestsToolkit = Toolkit.make(SendRequest, ListRequests, ReplyToRequest);
