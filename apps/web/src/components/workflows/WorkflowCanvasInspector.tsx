import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import type { RoleConfig, WorkflowDefinition } from "@t3tools/contracts";
import { GripVerticalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { memo } from "react";

import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow } from "../settings/settingsLayout";
import {
  canRemoveStage,
  describeStageInputs,
  humanizeWorkflowId,
  removeStage,
  routeLoopsBack,
  setRouteLimit,
  updateTask,
  workflowEndStepId,
} from "../library/WorkflowEditor.logic";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RouteLimitSelect } from "./RouteLimitSelect";
import { canRemoveRoute, connectRoute, removeRoute, stagesRoutingTo } from "./WorkflowCanvas.logic";
import { WorkflowStageSelect } from "./WorkflowStageSelect";

/** What a role dragged from the inspector carries: its role id. */
export const WORKFLOW_ROLE_DRAG_TYPE = "application/x-t3-workflow-role";

export type CanvasSelection =
  | { readonly kind: "stage" | "end"; readonly stepId: string }
  | { readonly kind: "route"; readonly stepId: string; readonly outcome: string };

interface InspectorProps {
  readonly definition: WorkflowDefinition;
  readonly roleName: (slot: string) => string;
  readonly stageName: (stepId: string) => string;
  readonly onChange: (definition: WorkflowDefinition) => void;
}

/** Settings for the stage, route or end step selected on the canvas. */
export const WorkflowCanvasInspector = memo(function WorkflowCanvasInspector({
  selection,
  onEditStage,
  roles,
  ...props
}: InspectorProps & {
  readonly selection: CanvasSelection | null;
  readonly onEditStage: (stepId: string) => void;
  /** Roles that can run a stage, offered to drag onto the canvas. */
  readonly roles: readonly RoleConfig[];
}) {
  const { definition, stageName } = props;
  const step = selection ? definition.steps[selection.stepId] : undefined;
  if (!selection || !step) {
    return (
      <SettingsGroup className="self-start">
        <SettingsRow
          title="Add a stage"
          description="Drag a role onto the canvas, then drag from a stage's outcome to route work."
        />
        <div className="grid gap-1 px-3 pb-3 sm:px-4">
          {roles.map((role) => (
            <div
              key={role.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(WORKFLOW_ROLE_DRAG_TYPE, role.id);
                event.dataTransfer.effectAllowed = "copy";
              }}
              className="flex cursor-grab items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent active:cursor-grabbing"
            >
              <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{role.name}</span>
            </div>
          ))}
        </div>
      </SettingsGroup>
    );
  }
  if (step.type === "end") {
    return (
      <SettingsGroup className="self-start">
        <SettingsRow
          title={stageName(selection.stepId)}
          description="A feature is done once a route leads here."
        />
      </SettingsGroup>
    );
  }
  if (selection.kind === "route") {
    const removable = canRemoveRoute(definition, selection.stepId);
    return (
      <SettingsGroup className="self-start">
        <RouteRow {...props} stepId={selection.stepId} outcome={selection.outcome} />
        <SettingsRow
          title="Remove route"
          description={
            removable
              ? `${stageName(selection.stepId)} stops reporting “${humanizeWorkflowId(selection.outcome).toLowerCase()}”.`
              : "A stage needs at least one outcome."
          }
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!removable}
              onClick={() =>
                props.onChange(removeRoute(definition, selection.stepId, selection.outcome))
              }
            >
              <Trash2Icon />
              Remove
            </Button>
          }
        />
      </SettingsGroup>
    );
  }

  const stepId = selection.stepId;
  const routedFrom = stagesRoutingTo(definition, stepId);
  const removable = canRemoveStage(definition, stepId);
  const first = definition.start === stepId;
  return (
    <SettingsGroup className="self-start">
      <SettingsRow
        title={stageName(stepId)}
        description={[props.roleName(step.role), step.task].filter(Boolean).join(" · ")}
        status={[
          describeStageInputs(definition, stepId),
          step.outputs?.length ? `writes ${step.outputs.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        control={
          <Button size="sm" variant="outline" onClick={() => onEditStage(stepId)}>
            <PencilIcon />
            Edit
          </Button>
        }
      />
      <SettingsRow
        title="Needs your approval"
        control={
          <Switch
            aria-label={`Approve ${stageName(stepId)}`}
            checked={step.gate === true}
            onCheckedChange={(gate) =>
              props.onChange(
                updateTask(definition, stepId, ({ gate: _gate, ...rest }) =>
                  gate ? { ...rest, gate: true } : rest,
                ),
              )
            }
          />
        }
      />
      {Object.keys(step.next).map((outcome) => (
        <RouteRow key={outcome} {...props} stepId={stepId} outcome={outcome} />
      ))}
      <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
        {first ? (
          <span className="text-xs text-muted-foreground">Features start here</span>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => props.onChange({ ...definition, start: stepId })}
          >
            Start here
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              // A disabled button gets no pointer events, so the span carries the tooltip.
              <span className="ms-auto" />
            }
          >
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!removable}
              onClick={() => props.onChange(removeStage(definition, stepId))}
            >
              <Trash2Icon />
              Remove
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {first
              ? "Make another stage first before removing this one."
              : !removable
                ? `Route ${routedFrom.map(stageName).join(", ")} elsewhere first.`
                : "Its routes go with it."}
          </TooltipPopup>
        </Tooltip>
      </div>
    </SettingsGroup>
  );
});

/** Where one outcome leads and, on a loop, how often it may be taken, as in the form. */
function RouteRow({
  definition,
  stageName,
  onChange,
  stepId,
  outcome,
}: InspectorProps & { readonly stepId: string; readonly outcome: string }) {
  const step = definition.steps[stepId];
  if (step?.type !== "task") return null;
  const target = step.next[outcome];
  if (target === undefined) return null;
  const limit = step.limits?.[outcome] ?? null;
  const endId = workflowEndStepId(definition);
  return (
    <SettingsRow
      title={humanizeWorkflowId(outcome)}
      control={
        <>
          <WorkflowStageSelect
            label={`Next stage after ${stageName(stepId)} ${outcome}`}
            value={target}
            options={[...orderWorkflowStages(definition).filter((id) => id !== stepId), endId]}
            stageName={(id) => (id === endId ? "Finish" : stageName(id))}
            onChange={(next) => onChange(connectRoute(definition, stepId, outcome, next))}
          />
          {routeLoopsBack(definition, stepId, outcome) ? (
            <RouteLimitSelect
              label={`Most times ${stageName(stepId)} ${outcome} is taken`}
              value={limit}
              onChange={(next) => onChange(setRouteLimit(definition, stepId, outcome, next))}
            />
          ) : null}
        </>
      }
    />
  );
}
