import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useAtomValue } from "@effect/atom-react";
import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import {
  PROJECT_MANAGER_ROLE_ID,
  type EnvironmentId,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "../../lib/utils";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { EditorField } from "../settings/CrewAgentFields";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { hasStarterRoles, useAddStarterRoles } from "./RoleEditor";
import { pruneUnusedRoles, workflowIdFromName, workflowMainPath } from "./WorkflowEditor.logic";

const STARTER_WORKFLOW_ID = "feature-delivery";
const STARTER_WORKFLOW_NAME = "Feature delivery";
/** Feature delivery's main path, from the server's starter workflow; its change review is the "+1". */
const STARTER_PREVIEW = { stages: ["plan", "design", "build", "qa", "review"], more: 1 } as const;
const BLANK_PREVIEW = { stages: ["build"], more: 0 } as const;

/** Blank, the starter template, or `copy:<workflow id>`. */
type StartFrom = "blank" | "template" | `copy:${string}`;

/** Names a workflow and starts it blank, from Feature delivery, or as a copy, then opens it. */
export function NewWorkflow({
  environmentId,
  workflows,
  roles,
  onCreated,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly workflows: ReadonlyArray<WorkflowDefinition>;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly onCreated: (workflowId: string) => void;
  readonly onCancel: () => void;
}) {
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const create = useAtomCommand(workflowsEnvironment.create);
  const revise = useAtomCommand(workflowsEnvironment.revise);
  const starterRoles = useAddStarterRoles(environmentId);
  const canAddStarter = useAtomValue(
    workflowsEnvironment.ensureStarter.permissionAtom(environmentId),
  );
  const canCreate = useAtomValue(workflowsEnvironment.create.permissionAtom(environmentId));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  // Picking a starting point suggests its name until you type your own.
  const [nameTyped, setNameTyped] = useState(false);
  const [startFrom, setStartFrom] = useState<StartFrom>("blank");
  const hasStarter = workflows.some((definition) => definition.id === STARTER_WORKFLOW_ID);
  const copies = workflows.toSorted((a, b) => a.name.localeCompare(b.name));
  const source = startFrom.startsWith("copy:")
    ? (workflows.find((definition) => `copy:${definition.id}` === startFrom) ?? null)
    : null;
  const trimmedName = name.trim();
  const canSubmit =
    !adding &&
    trimmedName.length > 0 &&
    (startFrom === "template" ? canAddStarter : canCreate) &&
    (!startFrom.startsWith("copy:") || source !== null);

  const pick = (next: StartFrom) => {
    setStartFrom(next);
    if (nameTyped) return;
    const picked = next.startsWith("copy:")
      ? workflows.find((definition) => `copy:${definition.id}` === next)
      : undefined;
    setName(next === "template" ? STARTER_WORKFLOW_NAME : picked ? `${picked.name} copy` : "");
  };

  /** Blank and Feature delivery run as the starter roles, so add them first when missing. */
  const ensureStarterRoles = async () =>
    hasStarterRoles(roles) || !starterRoles.ready || (await starterRoles.add());

  const reportError = (title: string, cause: Parameters<typeof formatEnvironmentQueryError>[0]) =>
    toastManager.add({ type: "error", title, description: formatEnvironmentQueryError(cause) });

  const createDefinition = async (definition: WorkflowDefinition) => {
    const result = await create({ environmentId, input: { definition } });
    if (result._tag === "Success") return result.value.id;
    reportError("Could not add the workflow", result.cause);
    return null;
  };

  const addStarter = async () => {
    const result = await ensureStarter({ environmentId, input: {} });
    if (result._tag !== "Success") {
      reportError("Could not add the starter workflow", result.cause);
      return null;
    }
    const starter = result.value;
    // The server names the starter itself, so a different name is a revision right after.
    if (trimmedName !== starter.name) {
      const renamed = await revise({
        environmentId,
        input: {
          definition: { ...starter, name: trimmedName, revision: starter.revision + 1 },
          expectedRevision: starter.revision,
        },
      });
      if (renamed._tag !== "Success")
        reportError(`Could not rename ${starter.name}`, renamed.cause);
    }
    return starter.id;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setAdding(true);
    const takenIds = workflows.map((workflow) => workflow.id);
    const createdId = await (async () => {
      if (source !== null) {
        return createDefinition(
          pruneUnusedRoles({
            ...source,
            id: workflowIdFromName(trimmedName, takenIds),
            name: trimmedName,
            revision: 1,
          }),
        );
      }
      if (!(await ensureStarterRoles())) return null;
      if (startFrom === "template") return addStarter();
      return createDefinition(
        blankWorkflow(
          workflowIdFromName(trimmedName, takenIds),
          trimmedName,
          (roleId) => roles.find((role) => role.id === roleId)?.revision ?? 1,
        ),
      );
    })();
    setAdding(false);
    if (createdId !== null) onCreated(createdId);
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">New workflow</h1>
        <p className="text-sm text-muted-foreground">
          The stages a feature moves through, and the role that runs each one.
        </p>
      </header>
      <EditorField label="Name" htmlFor="new-workflow-name">
        <Input
          id="new-workflow-name"
          autoFocus
          placeholder="Bug fix"
          value={name}
          maxLength={200}
          onChange={(event) => {
            setName(event.target.value);
            setNameTyped(event.target.value.length > 0);
          }}
        />
      </EditorField>
      <div className="grid gap-2">
        <Label id="new-workflow-start">Start from</Label>
        <RadioGroup
          aria-labelledby="new-workflow-start"
          value={startFrom}
          disabled={adding}
          onValueChange={(value) => pick(value as StartFrom)}
        >
          <StartOption
            value="blank"
            selected={startFrom === "blank"}
            title="Blank"
            description="One Build stage. Add stages and routes as you go."
            preview={BLANK_PREVIEW}
          />
          {hasStarter ? null : (
            <StartOption
              value="template"
              selected={startFrom === "template"}
              disabled={!canAddStarter}
              title={STARTER_WORKFLOW_NAME}
              badge="Template"
              description="The full crew. When a stage asks for changes, the project manager sends the work back to Design or Build."
              preview={STARTER_PREVIEW}
            />
          )}
          {copies.length > 0 ? (
            <p className="mt-1 px-0.5 text-xs font-medium text-muted-foreground">
              Copy one of yours
            </p>
          ) : null}
          {copies.map((definition) => (
            <StartOption
              key={definition.id}
              value={`copy:${definition.id}`}
              selected={startFrom === `copy:${definition.id}`}
              title={definition.name}
              description={null}
              preview={workflowMainPath(definition)}
            />
          ))}
        </RadioGroup>
      </div>
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="ghost-muted" size="sm" disabled={adding} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          Create workflow
        </Button>
      </div>
    </form>
  );
}

/** One starting point: a card with its stages along the main path. */
function StartOption({
  value,
  selected,
  disabled = false,
  title,
  badge,
  description,
  preview,
}: {
  readonly value: StartFrom;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly title: string;
  readonly badge?: string;
  readonly description: string | null;
  readonly preview: { readonly stages: readonly string[]; readonly more: number };
}) {
  return (
    <RadioPrimitive.Root
      value={value}
      disabled={disabled}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 text-left outline-none transition-[background-color,border-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-64",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-background ring-1 ring-inset ring-primary dark:bg-primary/10"
          : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary" : "border-input",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            {title}
            {badge ? (
              <Badge variant="secondary" size="sm">
                {badge}
              </Badge>
            ) : null}
          </span>
          {description ? (
            <span className="text-sm text-muted-foreground">{description}</span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {preview.stages.map((stepId, index) => (
            <Fragment key={stepId}>
              {index > 0 ? (
                <ArrowRightIcon aria-hidden className="size-3 text-muted-foreground" />
              ) : null}
              <span className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground">
                {formatStageName(stepId)}
              </span>
            </Fragment>
          ))}
          {preview.more > 0 ? (
            <span className="ml-1 text-xs text-muted-foreground">+{preview.more} more</span>
          ) : null}
        </span>
      </span>
    </RadioPrimitive.Root>
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
