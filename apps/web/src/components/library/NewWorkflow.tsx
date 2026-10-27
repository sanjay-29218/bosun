import { useAtomValue } from "@effect/atom-react";
import {
  PROJECT_MANAGER_ROLE_ID,
  type EnvironmentId,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { hasStarterRoles, useAddStarterRoles } from "./RoleEditor";
import { workflowIdFromName } from "./WorkflowEditor.logic";

const STARTER_WORKFLOW_ID = "feature-delivery";

/** Starts a named workflow from scratch, or adds Feature delivery, then opens it. */
export function NewWorkflow({
  environmentId,
  workflows,
  roles,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflows: ReadonlyArray<WorkflowDefinition>;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly onCreated: (workflowId: string) => void;
}) {
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const create = useAtomCommand(workflowsEnvironment.create);
  const starterRoles = useAddStarterRoles(environmentId);
  const canAddStarter = useAtomValue(
    workflowsEnvironment.ensureStarter.permissionAtom(environmentId),
  );
  const canCreate = useAtomValue(workflowsEnvironment.create.permissionAtom(environmentId));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const hasStarter = workflows.some((definition) => definition.id === STARTER_WORKFLOW_ID);

  /** Both starting points run as the starter roles, so add them first when they're missing. */
  const ensureStarterRoles = async () =>
    hasStarterRoles(roles) || !starterRoles.ready || (await starterRoles.add());

  const addBlank = async () => {
    if (name.trim().length === 0) return;
    setAdding(true);
    const createdId = await (async () => {
      if (!(await ensureStarterRoles())) return null;
      const definition = blankWorkflow(
        workflowIdFromName(
          name,
          workflows.map((workflow) => workflow.id),
        ),
        name.trim(),
        (roleId) => roles.find((role) => role.id === roleId)?.revision ?? 1,
      );
      const result = await create({ environmentId, input: { definition } });
      if (result._tag === "Success") return result.value.id;
      toastManager.add({
        type: "error",
        title: "Could not add the workflow",
        description: formatEnvironmentQueryError(result.cause),
      });
      return null;
    })();
    setAdding(false);
    if (createdId !== null) onCreated(createdId);
  };

  const addStarter = async () => {
    setAdding(true);
    const added = await (async () => {
      if (!(await ensureStarterRoles())) return false;
      const result = await ensureStarter({ environmentId, input: {} });
      if (result._tag === "Success") return true;
      toastManager.add({
        type: "error",
        title: "Could not add the starter workflow",
        description: formatEnvironmentQueryError(result.cause),
      });
      return false;
    })();
    setAdding(false);
    if (added) onCreated(STARTER_WORKFLOW_ID);
  };

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WorkflowIcon />
        </EmptyMedia>
        <EmptyTitle>New workflow</EmptyTitle>
        <EmptyDescription>
          Name it to start with one Build stage, then add stages and routes. To build on an existing
          workflow, open it and duplicate it.
        </EmptyDescription>
      </EmptyHeader>
      <form
        className="flex w-full max-w-sm items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addBlank();
        }}
      >
        <Input
          aria-label="Workflow name"
          placeholder="Bug fix"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={adding || !canCreate || name.trim().length === 0}>
          Create
        </Button>
      </form>
      {hasStarter ? null : (
        <Button
          size="sm"
          variant="ghost"
          disabled={adding || !canAddStarter}
          onClick={() => void addStarter()}
        >
          Or add Feature delivery: plan, design, build, test and review
        </Button>
      )}
    </Empty>
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
