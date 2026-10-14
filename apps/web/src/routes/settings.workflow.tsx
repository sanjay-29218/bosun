import { createFileRoute } from "@tanstack/react-router";
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
export const Route = createFileRoute("/settings/workflow")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environment === "string" && raw.environment.trim()
      ? { environment: EnvironmentId.make(raw.environment) }
      : {}),
    ...(typeof raw.workflow === "string" && raw.workflow.trim() ? { workflow: raw.workflow } : {}),
  }),
  component: SettingsWorkflowRoute,
});
