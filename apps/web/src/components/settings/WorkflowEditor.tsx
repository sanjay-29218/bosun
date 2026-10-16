import { type RoleConfig, type EnvironmentId, type WorkflowDefinition } from "@t3tools/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { rolesEnvironment } from "../../state/roles";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkflowStageSelect } from "../workflows/WorkflowStageSelect";
import { LimitField } from "./CrewLimitsSettings";
import { SettingsGroup } from "./SettingsGroup";
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
import { useDeleteWorkflow } from "./WorkflowsSettings";
import { WorkflowStageDialog } from "./WorkflowStageDialog";

// React Flow only loads once someone opens the canvas.
const WorkflowCanvas = lazy(() => import("../workflows/WorkflowCanvas"));
const EDITOR_VIEW_KEY = "t3code:workflow-editor-view";
const EditorView = Schema.Literals(["canvas", "form"]);

/** Search params of `/settings/workflow`, for links from the Workflows page. */
export interface WorkflowEditorTarget {
  readonly environment: EnvironmentId;
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
  const definitions = useEnvironmentQuery(
    connected
      ? workflowsEnvironment.definitions({ environmentId: target.environment, input: {} })
      : null,
  );
  const roles = useEnvironmentQuery(
    connected ? rolesEnvironment.roles({ environmentId: target.environment, input: {} }) : null,
  );
  const saved = definitions.data?.find((definition) => definition.id === target.workflow);
  const back = () => void navigate({ to: "/settings/workflows" });

  const message = !connected
    ? "Reconnect this workflow's environment to edit it."
    : (definitions.error ?? roles.error ?? null);
  if (message || !definitions.data || !roles.data || !saved) {
    return (
      <SettingsPageContainer>
        <div>
          <Button size="xs" variant="ghost" onClick={back}>
            <ArrowLeftIcon />
            Workflows
          </Button>
        </div>
        <SettingsSection title="Workflow">
          <SettingsRow
            title={
              message
                ? "Workflow unavailable"
                : definitions.data && roles.data
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
      key={saved.id}
      environmentId={target.environment}
      latest={saved}
      allWorkflowIds={definitions.data.map((definition) => definition.id)}
      roles={roles.data}
      onBack={back}
    />
  );
}

function WorkflowEditor({
  environmentId,
  latest,
  allWorkflowIds,
  roles,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  /** The newest published version, which can change while the editor is open. */
  readonly latest: WorkflowDefinition;
  readonly allWorkflowIds: readonly string[];
  readonly roles: readonly RoleConfig[];
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  const validate = useAtomCommand(workflowsEnvironment.validate);
  const revise = useAtomCommand(workflowsEnvironment.revise);
  const create = useAtomCommand(workflowsEnvironment.create);
  const deleteWorkflow = useDeleteWorkflow(environmentId);
  const crewRetries = useEnvironmentSettings(
    environmentId,
    (settings) => settings.crew.stageRetries,
  );
  // The version the draft started from. Settings on another device or an agent can publish a
  // newer one; a clean editor moves to it, while edits stay until they're discarded.
  const [saved, setSaved] = useState(latest);
  // Roles edited since this version are picked up here; publishing records them.
  const refreshed = useMemo(() => refreshWorkflowRoles(saved, roles), [saved, roles]);
  const [draft, setDraft] = useState(refreshed.definition);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageDialog, setStageDialog] = useState<{
    stepId: string | null;
    after?: string;
  } | null>(null);
  const [storedView, setView] = useLocalStorage(EDITOR_VIEW_KEY, "canvas", EditorView);
  // The canvas needs room to work in, so narrow screens always get the form.
  const canvasAvailable = useMediaQuery("md");
  const view = canvasAvailable ? storedView : "form";
  const edited = !sameWorkflow(draft, refreshed.definition);
  // Older than `saved` while the list catches up after this editor publishes.
  const superseded = latest.revision > saved.revision;
  // An open stage dialog holds edits of its own, so it keeps the version it started from too.
  if (superseded && !edited && stageDialog === null) {
    setSaved(latest);
    setDraft(refreshWorkflowRoles(latest, roles).definition);
  }
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

  const roleName = (slot: string) => {
    const roleId = draft.roles[slot]?.roleId;
    return roles.find((candidate) => candidate.id === roleId)?.name ?? humanizeWorkflowId(slot);
  };
  const stageName = (stepId: string) => (stepId === endId ? "Finish" : humanizeWorkflowId(stepId));

  const check = async (definition: WorkflowDefinition) => {
    const result = await validate({ environmentId, input: { definition } });
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
        input: { definition, expectedRevision: saved.revision },
      });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      setSaved(result.value);
      setDraft(result.value);
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
      const name = `${draft.name} copy`;
      const definition = pruneUnusedRoles({
        ...draft,
        // The copy takes unpublished edits along; the original keeps its published version.
        id: workflowIdFromName(name, allWorkflowIds),
        name,
        revision: 1,
      });
      if (!(await check(definition))) return;
      const result = await create({ environmentId, input: { definition } });
      if (result._tag !== "Success") {
        setError(formatEnvironmentQueryError(result.cause));
        return;
      }
      void navigate({
        to: "/settings/workflow",
        search: { environment: environmentId, workflow: result.value.id },
      });
    } finally {
      setBusy(false);
    }
  };

  const questionAndLimitRows = (
    <>
      <SettingsRow
        title="When a crew member asks a question"
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
    </>
  );

  return (
    <SettingsPageContainer width={view === "canvas" ? "expanded" : "readable"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Workflows
        </Button>
        <div className="flex items-center gap-2">
          {canvasAvailable ? (
            <ToggleGroup
              aria-label="Workflow editor view"
              variant="segmented"
              value={[view]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "canvas" || next === "form") setView(next);
              }}
            >
              <Toggle value="canvas">Canvas</Toggle>
              <Toggle value="form">Form</Toggle>
            </ToggleGroup>
          ) : null}
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
          <Button
            size="xs"
            disabled={!publishable || superseded || busy}
            onClick={() => void publish()}
          >
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
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void deleteWorkflow(draft).then((deleted) => {
                    if (deleted) void navigate({ to: "/settings/workflows" });
                  })
                }
              >
                Delete workflow
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {error ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {superseded ? (
        <Alert variant="warning">
          <AlertDescription>
            Version {latest.revision} was published while you were editing. Discard your edits to
            load it.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection title="Workflow" inert={busy}>
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
            <WorkflowStageSelect
              label="First stage"
              value={draft.start}
              options={stages}
              stageName={stageName}
              onChange={(start) => setDraft({ ...draft, start })}
            />
          }
        />
      </SettingsSection>

      {view === "canvas" ? (
        <>
          <SettingsSection title="Stages and routes" variant="plain" inert={busy}>
            <Suspense
              fallback={
                <SettingsGroup>
                  <SettingsRow title="Loading canvas…" role="status" />
                </SettingsGroup>
              }
            >
              <WorkflowCanvas
                definition={draft}
                roleName={roleName}
                stageName={stageName}
                onChange={setDraft}
                onEditStage={(stepId) => setStageDialog({ stepId })}
                onAddStage={(after) =>
                  setStageDialog(after ? { stepId: null, after } : { stepId: null })
                }
                roles={roles}
              />
            </Suspense>
          </SettingsSection>
          <SettingsSection title="Questions and limits" inert={busy}>
            {questionAndLimitRows}
          </SettingsSection>
        </>
      ) : (
        <>
          <SettingsSection
            title="Stages"
            inert={busy}
            headerAction={
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setStageDialog({ stepId: null })}
              >
                <PlusIcon className="size-3" />
                Add stage
              </Button>
            }
          >
            {stages.map((stepId, index) => {
              const step = draft.steps[stepId];
              if (step?.type !== "task") return null;
              const description = [
                roleName(step.role),
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

          <SettingsSection title="Routes" inert={busy}>
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
                        <WorkflowStageSelect
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
                          onCommit={(value) =>
                            setDraft(setRouteLimit(draft, stepId, outcome, value))
                          }
                        />
                      </>
                    }
                  />
                );
              });
            })}
            {questionAndLimitRows}
          </SettingsSection>
        </>
      )}

      {stageDialog ? (
        <WorkflowStageDialog
          definition={draft}
          stepId={stageDialog.stepId}
          after={stageDialog.after}
          roles={roles}
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
