import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import {
  PROJECT_MANAGER_ROLE_ID,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useId, useState } from "react";

import { DisclosureSection } from "../DisclosureSection";
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
  humanizeWorkflowId,
  normalizeReceives,
  parseList,
  renameStage,
  setStageOutcomes,
  stageIdFromName,
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
  const [name, setName] = useState(stepId ? stageName(stepId) : "");
  const [attempted, setAttempted] = useState(false);
  const [after, setAfter] = useState(
    initialAfter && stages.includes(initialAfter)
      ? initialAfter
      : (stages.at(-1) ?? definition.start),
  );
  const [role, setRole] = useState(currentRole);
  const [task, setTask] = useState(step?.task ?? "");
  const [outputs, setOutputs] = useState(step?.outputs?.join(", ") ?? "");
  const [scope, setScope] = useState(step?.scope ?? "");
  const [outcomes, setOutcomes] = useState<readonly string[]>(
    step ? Object.keys(step.next) : ["done"],
  );
  const [receivesMode, setReceivesMode] = useState<ReceivesMode>(step?.receives ? "picked" : "all");
  const [files, setFiles] = useState<readonly string[]>(step?.receives?.files ?? []);
  const [diffs, setDiffs] = useState<readonly string[]>(step?.receives?.diffs ?? []);

  // Renaming a stage gives it a new id; `qa` named "QA" keeps its own.
  const nameId = stageIdFromName(name, []);
  const targetId = stepId !== null && nameId === stepId ? stepId : nameId;
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
  const outcomeList = outcomes;
  const outputList = parseList(outputs);
  const problem =
    name.trim().length === 0
      ? "Name the stage."
      : targetId !== stepId && Object.hasOwn(definition.steps, targetId)
        ? "Another stage already has this name."
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
    setAttempted(true);
    if (problem) return;
    let next =
      stepId && targetId !== stepId ? renameStage(definition, stepId, targetId) : definition;
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
          [after]: { ...previous, next: { ...previous.next, [firstOutcome]: targetId } },
          [targetId]: {
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
            <div className={stepId ? undefined : "grid gap-4 sm:grid-cols-2"}>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  maxLength={72}
                  placeholder="Security review"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {!stepId ? (
                <div className="space-y-1.5">
                  <Label>Runs after</Label>
                  <OptionSelect
                    label="Runs after"
                    value={after}
                    options={stages.map((stage) => ({ value: stage, label: stageName(stage) }))}
                    onChange={setAfter}
                  />
                </div>
              ) : null}
            </div>
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
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-outcomes`}>Outcomes</Label>
              <OutcomeChips id={`${formId}-outcomes`} value={outcomes} onChange={setOutcomes} />
            </div>
            <DisclosureSection
              title="Advanced"
              summary={
                [
                  outputList.length > 0 ? "writes files" : null,
                  scope.trim() ? "scoped" : null,
                  receivesMode === "picked" ? "picked inputs" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              }
            >
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
                      No earlier stage writes anything yet. This stage gets the brief and your
                      notes.
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
            </DisclosureSection>
            {attempted && problem ? (
              <p role="alert" className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" onClick={save}>
            {stepId ? "Save stage" : "Add stage"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Outcomes as chips: Enter or a comma adds one, Backspace in the empty field removes the last. */
function OutcomeChips({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const outcome = text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    setText("");
    if (outcome && !value.includes(outcome)) onChange([...value, outcome]);
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/24 dark:bg-input/32">
      {value.map((outcome) => (
        <span
          key={outcome}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-secondary ps-2 pe-0.5 text-sm text-secondary-foreground"
        >
          {humanizeWorkflowId(outcome)}
          <button
            type="button"
            aria-label={`Remove ${humanizeWorkflowId(outcome)}`}
            className="flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onChange(value.filter((item) => item !== outcome))}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={value.length === 0 ? "approved, changes requested" : "Add outcome"}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => setText(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          } else if (event.key === "Backspace" && text === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
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
