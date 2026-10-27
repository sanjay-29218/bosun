import { useAtomValue } from "@effect/atom-react";
import {
  PROJECT_MANAGER_ROLE_ID,
  type EnvironmentId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { CrewEnvironmentNotice, useCrewSettingsEnvironment } from "./crewSettingsEnvironment";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useEnvironmentDefaultModel } from "./RolesSettings";
import {
  orderWorkflowStages,
  refreshWorkflowRoles,
  workflowIdFromName,
} from "./WorkflowEditor.logic";

/**
 * Deletes a workflow after confirming. The server refuses while an unfinished feature runs on
 * it or a bot starts its features with it, and says which. Resolves true once deleted.
 */
export function useDeleteWorkflow(environmentId: EnvironmentId) {
  const remove = useAtomCommand(workflowsEnvironment.delete);
  return async (definition: Pick<WorkflowDefinition, "id" | "name">) => {
    const confirmed = await requestConfirmDialog(
      `Delete ${definition.name}?\nFeatures that already finished keep their copy of it.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return false;
    const result = await remove({ environmentId, input: { id: definition.id } });
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: `Could not delete ${definition.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
    return false;
  };
}

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
  const initializeRoles = useAtomCommand(rolesEnvironment.initialize);
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  const canAdd = useAtomValue(workflowsEnvironment.ensureStarter.permissionAtom(environmentId));
  const create = useAtomCommand(workflowsEnvironment.create);
  const deleteWorkflow = useDeleteWorkflow(environmentId);
  const canDelete = useAtomValue(workflowsEnvironment.delete.permissionAtom(environmentId));
  const canCreate = useAtomValue(workflowsEnvironment.create.permissionAtom(environmentId));
  const [adding, setAdding] = useState(false);
  const saved = definitions.data ?? [];
  const hasStarter = saved.some((definition) => definition.id === "feature-delivery");

  /** Both starting points run as the starter roles, so add them first when they're missing. */
  const ensureStarterRoles = async () => {
    const hasStarterRoles = roles.data?.some((role) => role.id === PROJECT_MANAGER_ROLE_ID);
    if (hasStarterRoles || !defaultModel) return true;
    const initialized = await initializeRoles({
      environmentId,
      input: { modelSelection: defaultModel },
    });
    if (initialized._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: "Could not add the starter roles",
      description: formatEnvironmentQueryError(initialized.cause),
    });
    return false;
  };

  const addBlank = async () => {
    setAdding(true);
    await (async () => {
      if (!(await ensureStarterRoles())) return;
      const name = "New workflow";
      const definition = blankWorkflow(
        workflowIdFromName(
          name,
          saved.map((workflow) => workflow.id),
        ),
        name,
        (roleId) => roles.data?.find((role) => role.id === roleId)?.revision ?? 1,
      );
      const result = await create({ environmentId, input: { definition } });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not add the workflow",
          description: formatEnvironmentQueryError(result.cause),
        });
        return;
      }
      void navigate({
        to: "/settings/workflow",
        search: { environment: environmentId, workflow: result.value.id },
      });
    })();
    setAdding(false);
  };

  const addStarter = async () => {
    setAdding(true);
    await (async () => {
      if (!(await ensureStarterRoles())) return;
      const result = await ensureStarter({ environmentId, input: {} });
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: "Could not add the starter workflow",
          description: formatEnvironmentQueryError(result.cause),
        });
    })();
    setAdding(false);
  };

  return (
    <SettingsSection
      title="Workflows"
      id={searchableSetting("workflows").id}
      headerAction={
        saved.length > 0 ? (
          <div className="flex items-center gap-1">
            {!hasStarter ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={adding || !canAdd}
                onClick={() => void addStarter()}
              >
                Add starter workflow
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={adding || !canCreate}
              onClick={() => void addBlank()}
            >
              <PlusIcon />
              New workflow
            </Button>
          </div>
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
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={adding || !canAdd} onClick={() => void addStarter()}>
              Add starter workflow
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={adding || !canCreate}
              onClick={() => void addBlank()}
            >
              Start from scratch
            </Button>
          </div>
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
                <div className="flex items-center gap-1">
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
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={!canDelete}
                          aria-label={`Actions for ${definition.name}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        variant="destructive"
                        onClick={() => void deleteWorkflow(definition)}
                      >
                        <Trash2Icon />
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

/**
 * The smallest workflow to build on: one Build stage run by the builder, which the project
 * manager supervises, as in Feature delivery.
 */
function blankWorkflow(
  id: string,
  name: string,
  revisionOf: (roleId: string) => number,
): WorkflowDefinition {
  return {
    schemaVersion: 2,
    id,
    name,
    revision: 1,
    start: "build",
    roles: {
      manager: {
        roleId: PROJECT_MANAGER_ROLE_ID,
        roleRevision: revisionOf(PROJECT_MANAGER_ROLE_ID),
        supervisor: null,
      },
      builder: {
        roleId: "role:builder",
        roleRevision: revisionOf("role:builder"),
        supervisor: "manager",
      },
    },
    steps: {
      build: { type: "task", role: "builder", task: "Build it", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  };
}
