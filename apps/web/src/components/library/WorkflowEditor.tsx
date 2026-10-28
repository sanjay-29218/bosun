import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import { type RoleConfig, type EnvironmentId, type WorkflowDefinition } from "@t3tools/contracts";
import { useBlocker } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FlagIcon,
  ListIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useState, type ReactNode } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment } from "../../state/workflows";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RouteLimitSelect } from "../workflows/RouteLimitSelect";
import { WorkflowStageSelect } from "../workflows/WorkflowStageSelect";
import { LimitField } from "../settings/CrewLimitsSettings";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { LibraryFrame } from "./LibraryFrame";
import {
  canRemoveStage,
  humanizeWorkflowId,
  pruneUnusedRoles,
  refreshWorkflowRoles,
  removeStage,
  routeLoopsBack,
  sameWorkflow,
  setRouteLimit,
  updateTask,
  workflowEndStepId,
  workflowIdFromName,
  type WorkflowRoleIssue,
} from "./WorkflowEditor.logic";
import { WorkflowStageDialog } from "./WorkflowStageDialog";

// React Flow only loads once someone opens the canvas.
const WorkflowCanvas = lazy(() => import("../workflows/WorkflowCanvas"));
const EDITOR_VIEW_KEY = "t3code:workflow-editor-view";
const EditorView = Schema.Literals(["canvas", "form"]);

/**
 * Deletes a workflow after confirming. The server refuses while an unfinished feature runs on
 * it or a bot starts its features with it, and says which. Resolves true once deleted.
 */
function useDeleteWorkflow(environmentId: EnvironmentId) {
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

/** One workflow: stages and routes on the canvas or as a form, then Publish to make a new version. */
export function WorkflowEditor({
  title,
  environmentId,
  latest,
  allWorkflowIds,
  roles,
  onOpenWorkflow,
  onDeleted,
}: {
  readonly title: string | null;
  readonly environmentId: EnvironmentId;
  /** The newest published version, which can change while the editor is open. */
  readonly latest: WorkflowDefinition;
  readonly allWorkflowIds: readonly string[];
  readonly roles: readonly RoleConfig[];
  readonly onOpenWorkflow: (workflowId: string) => void;
  readonly onDeleted: () => void;
}) {
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
  const refreshed = refreshWorkflowRoles(saved, roles);
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
    await (async () => {
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
    })();
    setBusy(false);
  };

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    await (async () => {
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
      onOpenWorkflow(result.value.id);
    })();
    setBusy(false);
  };

  const settingsRows = (
    <>
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
        title="Retries before a stage fails"
        description="Then the feature pauses and you're notified."
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
        description="Then the feature stops at Your call."
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

  const viewToggle = (value: typeof EditorView.Type, label: string, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger render={<Toggle value={value} aria-label={label} />}>{icon}</TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );

  const actions = (
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
          {viewToggle("canvas", "Canvas", <WorkflowIcon />)}
          {viewToggle("form", "Form", <ListIcon />)}
        </ToggleGroup>
      ) : null}
      {edited ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(refreshed.definition);
            setError(null);
          }}
        >
          Discard
        </Button>
      ) : null}
      {publishable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="xs" disabled={superseded || busy} onClick={() => void publish()} />
            }
          >
            Publish
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-64">
            Publishes v{nextRevision}. Features that already started keep the version they began
            with.
          </TooltipPopup>
        </Tooltip>
      ) : null}
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
                if (deleted) onDeleted();
              })
            }
          >
            Delete workflow
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );

  return (
    <LibraryFrame
      title={title}
      badge={<Badge variant="outline">v{saved.revision}</Badge>}
      actions={actions}
    >
      <WorkspacePageContainer width={view === "canvas" ? "expanded" : "readable"}>
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
        {refreshed.issues.length > 0 ? (
          <Alert variant="warning">
            <AlertDescription>{roleIssueText(refreshed.issues, saved.revision)}</AlertDescription>
          </Alert>
        ) : null}

        {view === "canvas" ? (
          <div inert={busy}>
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
          </div>
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
                const name = stageName(stepId);
                return (
                  <SettingsRow
                    key={stepId}
                    title={`${index + 1}. ${name}`}
                    description={[roleName(step.role), step.task].filter(Boolean).join(" · ")}
                    control={
                      <>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          Approval
                          <Switch
                            size="sm"
                            aria-label={`${name} needs your approval`}
                            checked={step.gate === true}
                            onCheckedChange={(gate) =>
                              setDraft(
                                updateTask(draft, stepId, ({ gate: _gate, ...rest }) =>
                                  gate ? { ...rest, gate: true } : rest,
                                ),
                              )
                            }
                          />
                        </div>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Actions for ${name}`}
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
                              disabled={draft.start === stepId}
                              onClick={() => setDraft({ ...draft, start: stepId })}
                            >
                              <FlagIcon />
                              Start here
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
                      </>
                    }
                  >
                    <ul className="space-y-1.5 pt-2.5 pb-2 ps-4">
                      {Object.entries(step.next).map(([outcome, target]) => (
                        <li
                          key={outcome}
                          className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5"
                        >
                          <span className="min-w-0 flex-1 basis-32 truncate text-sm text-muted-foreground">
                            {humanizeWorkflowId(outcome)}
                          </span>
                          <ArrowRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                          <div className="w-40">
                            <WorkflowStageSelect
                              label={`Next stage after ${name} ${outcome}`}
                              value={target}
                              options={[...stages, endId]}
                              stageName={stageName}
                              onChange={(next) =>
                                setDraft(
                                  updateTask(draft, stepId, (task) => ({
                                    ...task,
                                    next: { ...task.next, [outcome]: next },
                                  })),
                                )
                              }
                            />
                          </div>
                          <div className="w-36">
                            {routeLoopsBack(draft, stepId, outcome) ? (
                              <RouteLimitSelect
                                label={`Most times ${name} ${outcome} is taken`}
                                value={step.limits?.[outcome] ?? null}
                                onChange={(limit) =>
                                  setDraft(setRouteLimit(draft, stepId, outcome, limit))
                                }
                              />
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </SettingsRow>
                );
              })}
            </SettingsSection>
          </>
        )}

        <SettingsSection title="Settings" inert={busy}>
          {settingsRows}
        </SettingsSection>

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
      </WorkspacePageContainer>
    </LibraryFrame>
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
      ? `${unavailable.join(", ")} is turned off or removed. Turn it on in Roles or give its stages another role.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}
