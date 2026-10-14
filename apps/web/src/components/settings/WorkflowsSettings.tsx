import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { CrewEnvironmentNotice, useCrewSettingsEnvironment } from "./crewSettingsEnvironment";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { orderWorkflowStages, refreshWorkflowRoles } from "./WorkflowEditor.logic";

/** The environment's workflow library; each workflow opens its own editor page. */
export function WorkflowsSettings() {
  const { environment, supported } = useCrewSettingsEnvironment("workflows");
  return (
    <SettingsPageContainer>
      {environment && supported ? (
        <WorkflowsSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsSection title="Workflows" id={searchableSetting("workflows").id}>
          <CrewEnvironmentNotice
            connected={environment !== null}
            supported={supported}
            noun="workflows"
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function WorkflowsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({ environmentId, input: {} }),
  );
  const roles = useEnvironmentQuery(rolesEnvironment.roles({ environmentId, input: {} }));
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const canAdd = useAtomValue(workflowsEnvironment.ensureStarter.permissionAtom(environmentId));
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

  return (
    <SettingsSection
      title="Workflows"
      id={searchableSetting("workflows").id}
      headerAction={
        !hasStarter && saved.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={adding || !canAdd}
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
          <Button size="sm" disabled={adding || !canAdd} onClick={() => void addStarter()}>
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
                      search: { environment: environmentId, workflow: definition.id },
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
    </SettingsSection>
  );
}
