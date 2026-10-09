import {
  type BotTemplateConfig,
  type EnvironmentId,
  type ProjectId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { botsEnvironment } from "../../state/bots";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { LimitField } from "./CrewLimitsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  canRemoveStage,
  describeStageInputs,
  humanizeWorkflowId,
  orderWorkflowStages,
  pruneUnusedRoles,
  refreshWorkflowRoles,
  removeStage,
  sameWorkflow,
  setRouteLimit,
  updateTask,
  workflowEndStepId,
  workflowIdFromName,
  type WorkflowRoleIssue,
} from "./WorkflowEditor.logic";
import { WorkflowStageDialog } from "./WorkflowStageDialog";

/** Search params of `/settings/workflow`, for links from Project settings and the Features page. */
export interface WorkflowEditorTarget {
  readonly environment: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workflow: string;
}

/** One workflow as a settings page: stages, routes, then Publish to make a new version. */
export function WorkflowEditorPage(target: WorkflowEditorTarget) {
  const { connectedEnvironments } = useSettingsScope();
  const navigate = useNavigate();
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === target.environment,
  );
  const connected = environment?.serverConfig?.environment.capabilities.workflows === true;
  const input = { projectId: target.projectId };
  const definitions = useEnvironmentQuery(
    connected
      ? workflowsEnvironment.definitions({ environmentId: target.environment, input })
      : null,
  );
  const configuration = useEnvironmentQuery(
    connected ? botsEnvironment.configuration({ environmentId: target.environment, input }) : null,
  );
  const saved = definitions.data?.find((definition) => definition.id === target.workflow);
  const back = () => void navigate({ to: "/settings/projects" });

  const message = !connected
    ? "Reconnect this workflow's environment to edit it."
    : (definitions.error ?? configuration.error ?? null);
  if (message || !definitions.data || !configuration.data || !saved) {
    return (
      <SettingsPageContainer>
        <div>
          <Button size="xs" variant="ghost" onClick={back}>
            <ArrowLeftIcon />
            Project settings
          </Button>
        </div>
        <SettingsSection title="Workflow">
          <SettingsRow
            title={
              message
                ? "Workflow unavailable"
                : definitions.data && configuration.data
                  ? "Workflow not found"
                  : "Loading workflow…"
            }
            {...(message ? { description: message } : {})}
            role="status"
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <WorkflowEditor
      // A new version replaces the draft, so the editor starts again from it.
      key={`${saved.id}:${saved.revision}`}
      environmentId={target.environment}
      projectId={target.projectId}
      saved={saved}
      allWorkflowIds={definitions.data.map((definition) => definition.id)}
      templates={configuration.data.templates}
      onBack={back}
    />
  );
}

function WorkflowEditor({
  environmentId,
  projectId,
  saved,
  allWorkflowIds,
  templates,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly saved: WorkflowDefinition;
  readonly allWorkflowIds: readonly string[];
  readonly templates: readonly BotTemplateConfig[];
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  const validate = useAtomCommand(workflowsEnvironment.validate);
  const revise = useAtomCommand(workflowsEnvironment.revise);
  const create = useAtomCommand(workflowsEnvironment.create);
  const crewRetries = useEnvironmentSettings(
    environmentId,
    (settings) => settings.crew.stageRetries,
  );
  // Roles edited since this version are picked up here; publishing records them.
  const refreshed = useMemo(() => refreshWorkflowRoles(saved, templates), [saved, templates]);
  const [draft, setDraft] = useState(refreshed.definition);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageDialog, setStageDialog] = useState<{ stepId: string | null } | null>(null);
  const edited = !sameWorkflow(draft, refreshed.definition);
  const publishable = !sameWorkflow(draft, saved);
  const stages = orderWorkflowStages(draft);
  const endId = workflowEndStepId(draft);
  const nextRevision = saved.revision + 1;

  useBlocker({
    shouldBlockFn: async () =>
      edited &&
      !busy &&
      (await requestConfirmDialog("Leave without publishing your edits?")) !== true,
    enableBeforeUnload: () => edited,
  });

  const roleName = (botId: string) => {
    const bot = draft.bots[botId];
    const template =
      bot?.template.kind === "template"
        ? templates.find((candidate) => candidate.id === bot.template.id)
        : undefined;
    return template?.name ?? humanizeWorkflowId(botId);
  };
  const stageName = (stepId: string) => (stepId === endId ? "Finish" : humanizeWorkflowId(stepId));

  const check = async (definition: WorkflowDefinition) => {
    const result = await validate({ environmentId, input: { projectId, definition } });
    if (result._tag === "Success") return true;
    setError(formatEnvironmentQueryError(result.cause));
    return false;
  };

  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const definition = pruneUnusedRoles({ ...draft, revision: nextRevision });
      if (!(await check(definition))) return;
      const result = await revise({
        environmentId,
        input: { projectId, definition, expectedRevision: saved.revision },
      });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      toastManager.add({ type: "success", title: `Published ${draft.name} v${nextRevision}` });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const name = `${saved.name} copy`;
      const definition = pruneUnusedRoles({
        ...refreshed.definition,
        id: workflowIdFromName(name, allWorkflowIds),
        name,
        revision: 1,
      });
      if (!(await check(definition))) return;
      const result = await create({ environmentId, input: { projectId, definition } });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      void navigate({
        to: "/settings/workflow",
        search: { environment: environmentId, projectId, workflow: result.value.id },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Project settings
        </Button>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!edited || busy}
            onClick={() => {
              setDraft(refreshed.definition);
              setError(null);
            }}
          >
            Discard
          </Button>
          <Button size="xs" disabled={!publishable || busy} onClick={() => void publish()}>
            Publish v{nextRevision}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label="More workflow actions"
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => void duplicate()}>Duplicate as new workflow</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Workflow">
        <SettingsRow
          title="Name"
          control={
            <Input
              size="sm"
              aria-label="Workflow name"
              value={draft.name}
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          }
        />
        <SettingsRow
          title={`Version ${saved.revision}`}
          description="Features that already started keep the version they began with. Publishing makes a new version for features started after it."
          status={
            refreshed.issues.length > 0
              ? roleIssueText(refreshed.issues, saved.revision)
              : undefined
          }
        />
        <SettingsRow
          title="First stage"
          control={
            <StageSelect
              label="First stage"
              value={draft.start}
              options={stages}
              stageName={stageName}
              onChange={(start) => setDraft({ ...draft, start })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Stages"
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={() => setStageDialog({ stepId: null })}>
            <PlusIcon className="size-3" />
            Add stage
          </Button>
        }
      >
        {stages.map((stepId, index) => {
          const step = draft.steps[stepId];
          if (step?.type !== "task") return null;
          const description = [
            roleName(step.bot),
            step.scope ? `scope ${step.scope}` : null,
            step.task,
          ]
            .filter(Boolean)
            .join(" · ");
          const status = [
            describeStageInputs(draft, stepId),
            step.outputs?.length ? `writes ${step.outputs.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={stepId}>
              <SettingsRow
                title={`${index + 1}. ${stageName(stepId)}`}
                description={description}
                status={status}
                control={
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Actions for ${stageName(stepId)}`}
                        />
                      }
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setStageDialog({ stepId })}>
                        <PencilIcon />
                        Edit
                      </MenuItem>
                      <MenuItem
                        disabled={!canRemoveStage(draft, stepId)}
                        onClick={() => setDraft(removeStage(draft, stepId))}
                      >
                        <Trash2Icon />
                        Remove
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                }
              />
              <SettingsRow
                className="ps-8 sm:ps-10"
                title={`Approve ${stageName(stepId).toLowerCase()}`}
                description="You approve or request changes before the feature moves on."
                control={
                  <Switch
                    aria-label={`Approve ${stageName(stepId)}`}
                    checked={step.gate === true}
                    onCheckedChange={(gate) =>
                      setDraft(
                        updateTask(draft, stepId, ({ gate: _gate, ...rest }) =>
                          gate ? { ...rest, gate: true } : rest,
                        ),
                      )
                    }
                  />
                }
              />
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Routes">
        {stages.flatMap((stepId) => {
          const step = draft.steps[stepId];
          if (step?.type !== "task") return [];
          return Object.entries(step.next).map(([outcome, target]) => {
            const limit = step.limits?.[outcome] ?? null;
            return (
              <SettingsRow
                key={`${stepId}:${outcome}`}
                title={`When ${stageName(stepId)} reports “${humanizeWorkflowId(outcome).toLowerCase()}”`}
                description={
                  limit === null
                    ? "Empty means no limit on how often this route is taken."
                    : `After ${limit} ${limit === 1 ? "time" : "times"}, the feature stops at Your call.`
                }
                control={
                  <>
                    <StageSelect
                      label={`Next stage after ${stageName(stepId)} ${outcome}`}
                      value={target}
                      options={[...stages, endId]}
                      stageName={(id) => (id === endId ? "Finish" : `Go to ${stageName(id)}`)}
                      onChange={(next) =>
                        setDraft(
                          updateTask(draft, stepId, (task) => ({
                            ...task,
                            next: { ...task.next, [outcome]: next },
                          })),
                        )
                      }
                    />
                    <LimitField
                      label={`Most times ${stageName(stepId)} ${outcome} is taken`}
                      value={limit}
                      min={1}
                      max={20}
                      placeholder="–"
                      allowEmpty
                      onCommit={(value) => setDraft(setRouteLimit(draft, stepId, outcome, value))}
                    />
                  </>
                }
              />
            );
          });
        })}
        <SettingsRow
          title="When a bot asks a question"
          description="The Manager answers first and asks you only when it can't."
          control={<span className="text-sm text-muted-foreground">Manager first, then you</span>}
        />
        <SettingsRow
          title="When a stage fails"
          description={`Pause and notify me after its automatic retries. Empty uses the Crew setting (${crewRetries}).`}
          control={
            <LimitField
              label="Retries before a stage fails"
              value={draft.defaults.retries ?? null}
              min={0}
              max={10}
              placeholder={String(crewRetries)}
              allowEmpty
              onCommit={(value) => {
                const { retries: _retries, ...defaults } = draft.defaults;
                setDraft({
                  ...draft,
                  defaults: value === null ? defaults : { ...defaults, retries: value },
                });
              }}
            />
          }
        />
        <SettingsRow
          title="Stage runs per feature"
          description="A feature stops at Your call after this many stage runs in total."
          control={
            <LimitField
              label="Stage runs per feature"
              value={draft.defaults.maxStepExecutions}
              min={1}
              max={500}
              onCommit={(value) => {
                if (value !== null)
                  setDraft({ ...draft, defaults: { ...draft.defaults, maxStepExecutions: value } });
              }}
            />
          }
        />
      </SettingsSection>

      {stageDialog ? (
        <WorkflowStageDialog
          definition={draft}
          stepId={stageDialog.stepId}
          templates={templates}
          roleName={roleName}
          stageName={stageName}
          onSave={(definition) => {
            setDraft(definition);
            setStageDialog(null);
          }}
          onClose={() => setStageDialog(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function roleIssueText(issues: readonly WorkflowRoleIssue[], revision: number): string {
  const changed = issues.filter((issue) => issue.reason === "changed").map((issue) => issue.name);
  const unavailable = issues
    .filter((issue) => issue.reason === "unavailable")
    .map((issue) => issue.name);
  return [
    changed.length > 0
      ? `${changed.join(", ")} changed since v${revision}. Publish to start new features with the change.`
      : null,
    unavailable.length > 0
      ? `${unavailable.join(", ")} is turned off or removed. Turn it on in Crew or give its stages another role.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function StageSelect({
  label,
  value,
  options,
  stageName,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly stageName: (stepId: string) => string;
  readonly onChange: (stepId: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(next: string) => stageName(next)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {stageName(option)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
