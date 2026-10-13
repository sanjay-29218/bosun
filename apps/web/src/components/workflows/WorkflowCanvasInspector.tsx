import type { WorkflowDefinition } from "@t3tools/contracts";
import { PencilIcon, Trash2Icon } from "lucide-react";

import { LimitField } from "../settings/CrewLimitsSettings";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow } from "../settings/settingsLayout";
import {
  canRemoveStage,
  describeStageInputs,
  humanizeWorkflowId,
  orderWorkflowStages,
  removeStage,
  setRouteLimit,
  updateTask,
  workflowEndStepId,
} from "../settings/WorkflowEditor.logic";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { canRemoveRoute, connectRoute, removeRoute, stagesRoutingTo } from "./WorkflowCanvas.logic";
import { WorkflowStageSelect } from "./WorkflowStageSelect";

export type CanvasSelection =
  | { readonly kind: "stage" | "end"; readonly stepId: string }
  | { readonly kind: "route"; readonly stepId: string; readonly outcome: string };

interface InspectorProps {
  readonly definition: WorkflowDefinition;
  readonly roleName: (botId: string) => string;
  readonly stageName: (stepId: string) => string;
  readonly onChange: (definition: WorkflowDefinition) => void;
}

/** Settings for the stage, route or end step selected on the canvas. */
export function WorkflowCanvasInspector({
  selection,
  onEditStage,
  ...props
}: InspectorProps & {
  readonly selection: CanvasSelection | null;
  readonly onEditStage: (stepId: string) => void;
}) {
  const { definition, stageName } = props;
  const step = selection ? definition.steps[selection.stepId] : undefined;
  if (!selection || !step) {
    return (
      <SettingsGroup className="self-start">
        <SettingsRow
          title="Select a stage or route"
          description="Drag from an outcome on a stage's right edge to another stage to route it there. Delete removes what's selected."
        />
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
  return (
    <SettingsGroup className="self-start">
      <SettingsRow
        title={stageName(stepId)}
        description={[
          props.roleName(step.bot),
          step.scope ? `scope ${step.scope}` : null,
          step.task,
        ]
          .filter(Boolean)
          .join(" · ")}
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
        title="Approve before moving on"
        description="You approve or request changes before the feature moves on."
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
      <SettingsRow
        title="First stage"
        description={
          definition.start === stepId
            ? "Features start here."
            : `Features start at ${stageName(definition.start)}.`
        }
        control={
          definition.start === stepId ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onChange({ ...definition, start: stepId })}
            >
              Start here
            </Button>
          )
        }
      />
      <SettingsRow
        title="Remove stage"
        description={
          definition.start === stepId
            ? "Make another stage first before removing this one."
            : !removable
              ? `Route ${routedFrom.map(stageName).join(", ")} elsewhere first.`
              : "Its routes go with it."
        }
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!removable}
            onClick={() => props.onChange(removeStage(definition, stepId))}
          >
            <Trash2Icon />
            Remove
          </Button>
        }
      />
    </SettingsGroup>
  );
}

/** Where one outcome leads and how often it may be taken, as in the form's Routes section. */
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
      title={`When ${stageName(stepId)} reports “${humanizeWorkflowId(outcome).toLowerCase()}”`}
      description={
        limit === null
          ? "Empty means no limit on how often this route is taken."
          : `After ${limit} ${limit === 1 ? "time" : "times"}, the feature stops at Your call.`
      }
      control={
        <>
          <WorkflowStageSelect
            label={`Next stage after ${stageName(stepId)} ${outcome}`}
            value={target}
            options={[...orderWorkflowStages(definition).filter((id) => id !== stepId), endId]}
            stageName={(id) => (id === endId ? "Finish" : `Go to ${stageName(id)}`)}
            onChange={(next) => onChange(connectRoute(definition, stepId, outcome, next))}
          />
          <LimitField
            label={`Most times ${stageName(stepId)} ${outcome} is taken`}
            value={limit}
            min={1}
            max={20}
            placeholder="–"
            allowEmpty
            onCommit={(value) => onChange(setRouteLimit(definition, stepId, outcome, value))}
          />
        </>
      }
    />
  );
}
