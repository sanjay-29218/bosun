import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { WorkflowEditorPage } from "../components/settings/WorkflowEditor";

function SettingsWorkflowRoute() {
  const target = Route.useSearch();
  if (!target.environment || !target.workflow) {
    return <p className="p-8 text-sm text-muted-foreground">Choose a workflow in Workflows.</p>;
  }
  return <WorkflowEditorPage environment={target.environment} workflow={target.workflow} />;
}

// Not `environmentId`: the settings layout reads that key as a legacy machine scope.
export const Route = createFileRoute("/_chat/settings/workflow")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environment === "string" && raw.environment.trim()
      ? { environment: EnvironmentId.make(raw.environment) }
      : {}),
    ...(typeof raw.workflow === "string" && raw.workflow.trim() ? { workflow: raw.workflow } : {}),
  }),
  // The settings scope pins one environment here; make it the workflow's, so a link to a
  // workflow on another environment doesn't open against the primary one.
  beforeLoad: ({ search }) => {
    if (search.environment && search.machine !== search.environment) {
      throw redirect({
        to: "/settings/workflow",
        search: {
          environment: search.environment,
          ...(search.workflow ? { workflow: search.workflow } : {}),
          machine: search.environment,
        },
        replace: true,
      });
    }
  },
  component: SettingsWorkflowRoute,
});
