import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { orderWorkflowStages, refreshWorkflowRoles } from "./WorkflowEditor.logic";
import { WorkflowFeatureInspector } from "./WorkflowFeatureInspector";

/** The environment's workflow library, shown from a project; each opens its own editor page. */
export function WorkflowsProjectSection({
  project,
  showEnvironment,
}: {
  readonly project: SidebarProjectGroupMember;
  readonly showEnvironment: boolean;
}) {
  const navigate = useNavigate();
  const environmentId = project.environmentId;
  const projectId = project.id;
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({ environmentId, input: {} }),
  );
  const roles = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const [adding, setAdding] = useState(false);
  const saved = definitions.data ?? [];
  const hasStarter = saved.some((definition) => definition.id === "feature-delivery");

  const addStarter = async () => {
    setAdding(true);
    try {
      const result = await ensureStarter({ environmentId, input: {} });
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: "Could not add the starter workflow",
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setAdding(false);
    }
  };
  const openCrew = () => void navigate({ to: "/settings/crew", search: (previous) => previous });

  return (
    <SettingsSection
      title={
        showEnvironment ? `Workflows · ${project.environmentLabel ?? "Environment"}` : "Workflows"
      }
      headerAction={
        !hasStarter && definitions.data ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={adding}
            onClick={() => void addStarter()}
          >
            Add starter workflow
          </Button>
        ) : null
      }
    >
      {definitions.error ? (
        <SettingsRow title="Could not load workflows" description={definitions.error} />
      ) : !definitions.data ? (
        <SettingsRow title="Loading workflows…" role="status" />
      ) : saved.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No workflows yet</EmptyTitle>
            <EmptyDescription>
              Start from Feature delivery: plan, design, build, test and review, with your approval
              after planning and design.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" disabled={adding} onClick={() => void addStarter()}>
            Add starter workflow
          </Button>
        </Empty>
      ) : (
        saved.map((definition) => {
          const stageCount = orderWorkflowStages(definition).length;
          const { issues } = roles.data
            ? refreshWorkflowRoles(definition, roles.data)
            : { issues: [] };
          return (
            <SettingsRow
              key={definition.id}
              title={definition.name}
              description={`v${definition.revision} · ${stageCount} ${stageCount === 1 ? "stage" : "stages"}`}
              status={
                issues.length > 0
                  ? `${issues.map((issue) => issue.name).join(", ")} changed. Publish a new version before starting features.`
                  : undefined
              }
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/settings/workflow",
                      search: { environment: environmentId, projectId, workflow: definition.id },
                    })
                  }
                >
                  Edit
                </Button>
              }
            />
          );
        })
      )}
      <SettingsRow
        title="Crew"
        description="The roles stages run as, and how many agents run at once."
        control={
          <Button size="sm" variant="outline" onClick={openCrew}>
            Open Crew settings
          </Button>
        }
      />
      <div className="px-3 pb-3 sm:px-4">
        <WorkflowFeatureInspector environmentId={environmentId} projectId={projectId} />
      </div>
    </SettingsSection>
  );
}
