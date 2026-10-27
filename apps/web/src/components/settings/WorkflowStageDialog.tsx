import {
  PROJECT_MANAGER_ROLE_ID,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  WORKFLOW_ID_PATTERN,
  earlierStageOutputs,
  ensureWorkflowRole,
  normalizeReceives,
  orderWorkflowStages,
  parseList,
  setStageOutcomes,
  updateTask,
} from "./WorkflowEditor.logic";

type ReceivesMode = "all" | "picked";

/** Adds a stage after another one, or edits an existing stage's role, task, outputs and outcomes. */
export function WorkflowStageDialog({
  definition,
  stepId,
  after: initialAfter,
  roles,
  roleName,
  stageName,
  onSave,
  onClose,
}: {
  readonly definition: WorkflowDefinition;
  /** Null adds a stage. */
  readonly stepId: string | null;
  /** Where an added stage goes; the last stage when absent. */
  readonly after?: string | undefined;
  readonly roles: readonly RoleConfig[];
  readonly roleName: (slot: string) => string;
  readonly stageName: (stepId: string) => string;
  readonly onSave: (definition: WorkflowDefinition) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const stages = orderWorkflowStages(definition);
  const existing = stepId ? definition.steps[stepId] : undefined;
  const step = existing?.type === "task" ? existing : null;
  // Roles a stage can run as: the workflow's project manager slot and enabled roles.
  const roleOptions = [
    ...Object.entries(definition.roles)
      .filter(([, entry]) => entry.roleId === PROJECT_MANAGER_ROLE_ID)
      .map(([slot]) => ({ value: `slot:${slot}`, label: roleName(slot) })),
    ...roles
      .filter(
        (config) =>
          config.id !== PROJECT_MANAGER_ROLE_ID && config.enabled && config.autoCreateForFeature,
      )
      .map((config) => ({ value: `role:${config.id}`, label: config.name })),
  ];
  const currentRole = step
    ? (() => {
        const entry = definition.roles[step.role];
        return entry && entry.roleId !== PROJECT_MANAGER_ROLE_ID
          ? `role:${entry.roleId}`
          : `slot:${step.role}`;
      })()
    : (roleOptions.find((option) => option.value.startsWith("role:"))?.value ?? "");
  const [id, setId] = useState("");
  const [after, setAfter] = useState(
    initialAfter && stages.includes(initialAfter)
      ? initialAfter
      : (stages.at(-1) ?? definition.start),
  );
  const [role, setRole] = useState(currentRole);
  const [task, setTask] = useState(step?.task ?? "");
  const [outputs, setOutputs] = useState(step?.outputs?.join(", ") ?? "");
  const [scope, setScope] = useState(step?.scope ?? "");
  const [outcomes, setOutcomes] = useState(step ? Object.keys(step.next).join(", ") : "done");
  const [receivesMode, setReceivesMode] = useState<ReceivesMode>(step?.receives ? "picked" : "all");
  const [files, setFiles] = useState<readonly string[]>(step?.receives?.files ?? []);
  const [diffs, setDiffs] = useState<readonly string[]>(step?.receives?.diffs ?? []);

  const targetId = stepId ?? id;
  // A new stage sits after `after`, so it can pick what that stage and the ones before it produce.
  const earlier = stepId
    ? earlierStageOutputs(definition, stepId)
    : (() => {
        const upTo = stages.slice(0, stages.indexOf(after) + 1);
        return {
          files: [
            ...new Set(
              upTo.flatMap((candidate) => {
                const other = definition.steps[candidate];
                return other?.type === "task" ? (other.outputs ?? []) : [];
              }),
            ),
          ],
          diffs: upTo,
        };
      })();
  const outcomeList = parseList(outcomes);
  const outputList = parseList(outputs);
  const problem =
    !stepId && !WORKFLOW_ID_PATTERN.test(id)
      ? "Stage ids start with a letter and use lowercase letters, numbers, - and _."
      : !stepId && Object.hasOwn(definition.steps, id)
        ? "Another stage already uses this id."
        : !role
          ? "Choose a role."
          : task.trim().length === 0
            ? "Describe the stage's task."
            : outcomeList.length < 1 || outcomeList.length > 8
              ? "A stage reports between 1 and 8 outcomes."
              : !outcomeList.every((outcome) => WORKFLOW_ID_PATTERN.test(outcome))
                ? "Outcomes use lowercase letters, numbers, - and _."
                : outputList.some((path) => path.startsWith("/") || path.split("/").includes(".."))
                  ? "Outputs are paths inside the worktree."
                  : null;

  const save = () => {
    if (problem) return;
    let next = definition;
    let slot: string;
    if (role.startsWith("role:")) {
      const config = roles.find((candidate) => `role:${candidate.id}` === role);
      if (!config) return;
      const ensured = ensureWorkflowRole(next, config);
      next = ensured.definition;
      slot = ensured.slot;
    } else {
      slot = role.slice("slot:".length);
    }
    if (!stepId) {
      // The new stage takes over the previous stage's first route.
      const previous = next.steps[after];
      if (previous?.type !== "task") return;
      const [firstOutcome, followingStep] = Object.entries(previous.next)[0] ?? [];
      if (!firstOutcome || !followingStep) return;
      next = {
        ...next,
        steps: {
          ...next.steps,
          [after]: { ...previous, next: { ...previous.next, [firstOutcome]: id } },
          [id]: {
            type: "task",
            role: slot,
            task: "",
            next: Object.fromEntries(outcomeList.map((outcome) => [outcome, followingStep])),
          },
        },
      };
    } else {
      next = setStageOutcomes(next, targetId, outcomeList);
    }
    next = updateTask(
      next,
      targetId,
      ({ outputs: _outputs, receives: _receives, scope: _scope, ...rest }) => ({
        ...rest,
        role: slot,
        task: task.trim(),
        ...(outputList.length > 0 ? { outputs: outputList } : {}),
        ...(receivesMode === "picked"
          ? { receives: { files: [...files], diffs: [...diffs] } }
          : {}),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
      }),
    );
    onSave(normalizeReceives(next));
  };

  const toggle = (
    list: readonly string[],
    setList: (next: readonly string[]) => void,
    value: string,
    checked: boolean,
  ) => setList(checked ? [...list, value] : list.filter((item) => item !== value));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{stepId ? `Edit ${stageName(stepId)}` : "Add stage"}</DialogTitle>
          <DialogDescription>
            Changes apply to features started after you publish.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {!stepId ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${formId}-id`}>Stage id</Label>
                  <Input
                    id={`${formId}-id`}
                    value={id}
                    placeholder="security-review"
                    onChange={(event) => setId(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Runs after</Label>
                  <OptionSelect
                    label="Runs after"
                    value={after}
                    options={stages.map((stage) => ({ value: stage, label: stageName(stage) }))}
                    onChange={setAfter}
                  />
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Role</Label>
              <OptionSelect label="Role" value={role} options={roleOptions} onChange={setRole} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-task`}>Task</Label>
              <Textarea
                id={`${formId}-task`}
                value={task}
                rows={3}
                maxLength={8_000}
                placeholder="What this stage does"
                onChange={(event) => setTask(event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-outputs`}>Writes</Label>
                <Input
                  id={`${formId}-outputs`}
                  value={outputs}
                  placeholder="plan.md"
                  onChange={(event) => setOutputs(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-scope`}>Scope</Label>
                <Input
                  id={`${formId}-scope`}
                  value={scope}
                  placeholder="apps/web"
                  onChange={(event) => setScope(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-outcomes`}>Outcomes</Label>
              <Input
                id={`${formId}-outcomes`}
                value={outcomes}
                placeholder="approved, changes_requested"
                onChange={(event) => setOutcomes(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Gets</Label>
              <OptionSelect
                label="What this stage gets"
                value={receivesMode}
                options={[
                  { value: "all", label: "Every earlier output" },
                  { value: "picked", label: "Only what I pick" },
                ]}
                onChange={(value) => setReceivesMode(value === "picked" ? "picked" : "all")}
              />
              {receivesMode === "picked" ? (
                earlier.files.length + earlier.diffs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No earlier stage writes anything yet. This stage gets the brief and your notes.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {earlier.files.map((file) => (
                      <label key={`file:${file}`} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={files.includes(file)}
                          onCheckedChange={(checked) =>
                            toggle(files, setFiles, file, checked === true)
                          }
                        />
                        {file}
                      </label>
                    ))}
                    {earlier.diffs.map((stage) => (
                      <label key={`diff:${stage}`} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={diffs.includes(stage)}
                          onCheckedChange={(checked) =>
                            toggle(diffs, setDiffs, stage, checked === true)
                          }
                        />
                        {stageName(stage)} changes
                      </label>
                    ))}
                  </div>
                )
              ) : null}
            </div>
            {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={problem !== null} onClick={save}>
            {stepId ? "Save stage" : "Add stage"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OptionSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {(next: string) => options.find((option) => option.value === next)?.label ?? ""}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
