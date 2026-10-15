import { type WorkflowBot, type WorkflowDefinition, type WorkflowStep } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useMemo, useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { botsEnvironment } from "../../state/bots";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";
import { WorkflowFeatureInspector } from "./WorkflowFeatureInspector";

const idPattern = /^[a-z][a-z0-9_-]{0,79}$/;

function OutcomeRouteRow({
  stepId,
  outcome,
  target,
  stepIds,
  canRemove,
  onRename,
  onTarget,
  onRemove,
}: {
  readonly stepId: string;
  readonly outcome: string;
  readonly target: string;
  readonly stepIds: ReadonlyArray<string>;
  readonly canRemove: boolean;
  readonly onRename: (next: string) => boolean;
  readonly onTarget: (next: string) => void;
  readonly onRemove: () => void;
}) {
  const [draftName, setDraftName] = useState(outcome);
  const commitName = () => {
    if (draftName === outcome) return;
    if (!onRename(draftName)) setDraftName(outcome);
  };
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <Input
        aria-label={`Outcome from ${stepId}`}
        value={draftName}
        onChange={(event) => setDraftName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <select
        aria-label={`Next step for ${stepId} outcome ${outcome}`}
        value={target}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        onChange={(event) => onTarget(event.target.value)}
      >
        {stepIds.map((other) => (
          <option key={other} value={other}>
            {other}
          </option>
        ))}
      </select>
      <Button size="sm" variant="ghost" disabled={!canRemove} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

export function WorkflowsProjectSection({
  project,
  featureId,
}: {
  readonly featureId?: string | undefined;
  readonly project: SidebarProjectGroupMember;
}) {
  const environmentId = project.environmentId;
  const projectId = project.id;
  const definitions = useEnvironmentQuery(
    workflowsEnvironment.definitions({ environmentId, input: { projectId } }),
  );
  const configuration = useEnvironmentQuery(
    botsEnvironment.configuration({ environmentId, input: { projectId } }),
  );
  const ensureStarter = useAtomCommand(workflowsEnvironment.ensureStarter);
  const validate = useAtomCommand(workflowsEnvironment.validate);
  const create = useAtomCommand(workflowsEnvironment.create);
  const revise = useAtomCommand(workflowsEnvironment.revise);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [baseRevision, setBaseRevision] = useState(0);
  const [newStepId, setNewStepId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = definitions.data ?? [];
  const templates = (configuration.data?.templates ?? []).filter(
    (template) => template.enabled && template.autoCreateForFeature,
  );
  const botIds = useMemo(() => Object.keys(draft?.bots ?? {}), [draft?.bots]);
  const stepIds = useMemo(() => Object.keys(draft?.steps ?? {}), [draft?.steps]);
  const endStepId = stepIds.find((id) => draft?.steps[id]?.type === "end") ?? "end";

  const choose = (definition: WorkflowDefinition) => {
    setDraft({ ...structuredClone(definition), revision: definition.revision + 1 });
    setIsNew(false);
    setBaseRevision(definition.revision);
    setMessage(null);
    setError(null);
  };
  const updateBot = (id: string, change: (bot: WorkflowBot) => WorkflowBot) => {
    setDraft((current) =>
      current && current.bots[id]
        ? { ...current, bots: { ...current.bots, [id]: change(current.bots[id]!) } }
        : current,
    );
  };
  const updateStep = (id: string, change: (step: WorkflowStep) => WorkflowStep) => {
    setDraft((current) =>
      current && current.steps[id]
        ? { ...current, steps: { ...current.steps, [id]: change(current.steps[id]!) } }
        : current,
    );
  };
  const run = async (
    action: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause as Cause.Cause<unknown>));
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    if (!draft) return false;
    const okay = await run(() =>
      validate({ environmentId, input: { projectId, definition: draft } }),
    );
    if (okay) setMessage("Definition is valid and ready to save.");
    return okay;
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const checked = await validate({ environmentId, input: { projectId, definition: draft } });
      if (checked._tag !== "Success") {
        setError(formatEnvironmentQueryError(checked.cause));
        return;
      }
      const result = isNew
        ? await create({ environmentId, input: { projectId, definition: draft } })
        : await revise({
            environmentId,
            input: { projectId, definition: draft, expectedRevision: baseRevision },
          });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        definitions.refresh();
        return;
      }
      setMessage(`Saved revision ${result.value.revision}.`);
      setDraft({ ...structuredClone(result.value), revision: result.value.revision + 1 });
      setBaseRevision(result.value.revision);
      setIsNew(false);
      definitions.refresh();
    } finally {
      setBusy(false);
    }
  };
  const clone = () => {
    if (!draft) return;
    setDraft({
      ...structuredClone(draft),
      id: `${draft.id}-copy`,
      name: `${draft.name} copy`,
      revision: 1,
    });
    setIsNew(true);
    setBaseRevision(0);
    setMessage(null);
    setError(null);
  };
  const addBot = () => {
    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!draft || !template) return;
    const base =
      template.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "bot";
    let id = base;
    for (let suffix = 2; Object.hasOwn(draft.bots, id); suffix++) id = `${base}-${suffix}`;
    setDraft({
      ...draft,
      bots: {
        ...draft.bots,
        [id]: {
          template: { kind: "template", id: template.id, revision: template.revision },
          supervisor: null,
        },
      },
    });
    setSelectedTemplateId("");
  };
  const addStep = () => {
    if (!draft || !idPattern.test(newStepId) || Object.hasOwn(draft.steps, newStepId)) return;
    const bot = botIds[0];
    if (!bot) return;
    setDraft({
      ...draft,
      steps: {
        ...draft.steps,
        [newStepId]: {
          type: "task",
          bot,
          task: "Describe the work",
          next: { done: endStepId },
        },
      },
    });
    setNewStepId("");
  };

  return (
    <SettingsSection title="Workflows">
      <div className="space-y-4 px-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-sm text-muted-foreground">
            Choose bots, supervision, tasks, and outcome routes for future features. Saved revisions
            do not change existing feature copies.
          </p>
          {!saved.some((item) => item.id === "feature-delivery") ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void run(() => ensureStarter({ environmentId, input: { projectId } })).then(
                  (okay) => {
                    if (okay) definitions.refresh();
                  },
                );
              }}
            >
              Add starter workflow
            </Button>
          ) : null}
        </div>
        {definitions.error ? <p className="text-sm text-destructive">{definitions.error}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-1">
            {saved.map((definition) => (
              <button
                key={definition.id}
                type="button"
                aria-pressed={!isNew && draft?.id === definition.id}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
                onClick={() => choose(definition)}
              >
                <span className="block truncate font-medium">{definition.name}</span>
                <span className="text-xs text-muted-foreground">
                  Revision {definition.revision}
                </span>
              </button>
            ))}
            {saved.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">No workflows yet.</p>
            ) : null}
          </div>
          {draft ? (
            <div className="min-w-0 space-y-5 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">
                    {isNew ? "New workflow" : `Editing revision ${baseRevision + 1}`}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Only one task path runs at a time in this version.
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={clone}>
                  Copy as new
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Workflow ID</span>
                  <Input
                    aria-label="Workflow ID"
                    value={draft.id}
                    disabled={!isNew}
                    onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Name</span>
                  <Input
                    aria-label="Workflow name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
              </div>
              <div className="space-y-3 border-t border-border pt-4">
                <div>
                  <h4 className="text-sm font-medium">Bot assignments</h4>
                  <p className="text-xs text-muted-foreground">
                    Supervision routes questions; it does not move steps.
                  </p>
                </div>
                {Object.entries(draft.bots).map(([id, bot]) => (
                  <div
                    key={id}
                    className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium">{id}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {bot.template.id}{" "}
                        {bot.template.kind === "template" ? `· rev ${bot.template.revision}` : ""}
                      </span>
                    </div>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>Supervisor</span>
                      <select
                        aria-label={`Supervisor for ${id}`}
                        value={bot.supervisor ?? ""}
                        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                        onChange={(event) =>
                          updateBot(id, (previous) => ({
                            ...previous,
                            supervisor: event.target.value || null,
                          }))
                        }
                      >
                        <option value="">None</option>
                        {botIds
                          .filter((other) => other !== id)
                          .map((other) => (
                            <option key={other} value={other}>
                              {other}
                            </option>
                          ))}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        Object.values(draft.steps).some(
                          (step) => step.type === "task" && step.bot === id,
                        ) || Object.values(draft.bots).some((item) => item.supervisor === id)
                      }
                      onClick={() => {
                        const bots = { ...draft.bots };
                        delete bots[id];
                        setDraft({ ...draft, bots });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label="Template to add"
                    value={selectedTemplateId}
                    className="h-9 min-w-48 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    onChange={(event) => setSelectedTemplateId(event.target.value)}
                  >
                    <option value="">Choose feature template</option>
                    {templates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selectedTemplateId}
                    onClick={addBot}
                  >
                    Add bot
                  </Button>
                </div>
              </div>
              <div className="space-y-3 border-t border-border pt-4">
                <div>
                  <h4 className="text-sm font-medium">Task route</h4>
                  <p className="text-xs text-muted-foreground">
                    A recorded outcome selects the next task. Routes can return to earlier tasks for
                    rework.
                  </p>
                </div>
                <label className="block max-w-xs space-y-1 text-xs text-muted-foreground">
                  <span>Starting task</span>
                  <select
                    aria-label="Starting task"
                    value={draft.start}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                  >
                    {Object.entries(draft.steps)
                      .filter(([, step]) => step.type === "task")
                      .map(([id]) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                  </select>
                </label>
                {Object.entries(draft.steps).map(([id, step], index) =>
                  step.type === "end" ? (
                    <div
                      key={id}
                      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                    >
                      {index + 1}. End · {id}
                    </div>
                  ) : (
                    <div key={id} className="space-y-3 rounded-md border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <h5 className="text-sm font-medium">
                          {index + 1}. {id}
                        </h5>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            id === draft.start ||
                            Object.values(draft.steps).some(
                              (other) =>
                                other.type === "task" && Object.values(other.next).includes(id),
                            )
                          }
                          onClick={() => {
                            const steps = { ...draft.steps };
                            delete steps[id];
                            setDraft({ ...draft, steps });
                          }}
                        >
                          Remove task
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                        <label className="space-y-1 text-xs text-muted-foreground">
                          <span>Assigned bot</span>
                          <select
                            aria-label={`Bot for ${id}`}
                            value={step.bot}
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                            onChange={(event) =>
                              updateStep(id, (previous) =>
                                previous.type === "task"
                                  ? { ...previous, bot: event.target.value }
                                  : previous,
                              )
                            }
                          >
                            {botIds.map((botId) => (
                              <option key={botId} value={botId}>
                                {botId}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="space-y-1 text-xs text-muted-foreground">
                          <span>Task</span>
                          <Textarea
                            aria-label={`Task for ${id}`}
                            value={step.task}
                            rows={2}
                            onChange={(event) =>
                              updateStep(id, (previous) =>
                                previous.type === "task"
                                  ? { ...previous, task: event.target.value }
                                  : previous,
                              )
                            }
                          />
                        </label>
                      </div>
                      <div className="space-y-2">
                        <span className="text-xs text-muted-foreground">Outcome routes</span>
                        {Object.entries(step.next).map(([outcome, target]) => (
                          <OutcomeRouteRow
                            key={outcome}
                            stepId={id}
                            outcome={outcome}
                            target={target}
                            stepIds={stepIds}
                            canRemove={Object.keys(step.next).length > 1}
                            onRename={(nextName) => {
                              if (
                                !idPattern.test(nextName) ||
                                (nextName !== outcome && Object.hasOwn(step.next, nextName))
                              )
                                return false;
                              updateStep(id, (previous) => {
                                if (previous.type !== "task") return previous;
                                return {
                                  ...previous,
                                  next: Object.fromEntries(
                                    Object.entries(previous.next).map(([key, value]) => [
                                      key === outcome ? nextName : key,
                                      value,
                                    ]),
                                  ),
                                };
                              });
                              return true;
                            }}
                            onTarget={(targetId) =>
                              updateStep(id, (previous) => {
                                return previous.type === "task"
                                  ? { ...previous, next: { ...previous.next, [outcome]: targetId } }
                                  : previous;
                              })
                            }
                            onRemove={() =>
                              updateStep(id, (previous) => {
                                if (previous.type !== "task") return previous;
                                const next = { ...previous.next };
                                delete next[outcome];
                                return { ...previous, next };
                              })
                            }
                          />
                        ))}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateStep(id, (previous) => {
                              if (previous.type !== "task") return previous;
                              let key = "outcome";
                              for (let suffix = 2; Object.hasOwn(previous.next, key); suffix++)
                                key = `outcome_${suffix}`;
                              return { ...previous, next: { ...previous.next, [key]: endStepId } };
                            })
                          }
                        >
                          Add outcome
                        </Button>
                      </div>
                    </div>
                  ),
                )}
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label="New task ID"
                    value={newStepId}
                    placeholder="task-id"
                    onChange={(event) => setNewStepId(event.target.value)}
                    className="max-w-48"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !idPattern.test(newStepId) ||
                      Object.hasOwn(draft.steps, newStepId) ||
                      botIds.length === 0
                    }
                    onClick={addStep}
                  >
                    Add task
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Attempts per execution</span>
                  <Input
                    aria-label="Attempts per execution"
                    type="number"
                    min={1}
                    max={10}
                    value={draft.defaults.maxAttemptsPerExecution}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        defaults: {
                          ...draft.defaults,
                          maxAttemptsPerExecution: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Maximum step executions</span>
                  <Input
                    aria-label="Maximum step executions"
                    type="number"
                    min={1}
                    max={500}
                    value={draft.defaults.maxStepExecutions}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        defaults: {
                          ...draft.defaults,
                          maxStepExecutions: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                  Validate
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void save()}>
                  {isNew ? "Create workflow" : "Save revision"}
                </Button>
                {!isNew ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      const current = saved.find((item) => item.id === draft.id);
                      if (current) choose(current);
                    }}
                  >
                    Discard edits
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a workflow to inspect or edit it.
            </p>
          )}
        </div>
        <WorkflowFeatureInspector
          key={featureId ?? "manual"}
          initialFeatureId={featureId}
          environmentId={environmentId}
          projectId={projectId}
        />
      </div>
    </SettingsSection>
  );
}
