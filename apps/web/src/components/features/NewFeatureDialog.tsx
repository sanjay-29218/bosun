import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, FolderIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState, type KeyboardEvent } from "react";

import { formatShortcutLabel } from "../../keybindings";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useBotRailProjectKeys } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { botsEnvironment } from "../../state/bots";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { ComposerSurface } from "../chat/ComposerSurface";
import { CrewMenu, WorkflowMenu } from "../crew/ComposerWorkflowPicker";
import { botDefaultWorkflowId } from "../crew/crewDraftStore";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { closeNewFeatureDialog, newFeatureDialogAtom, type NewFeatureTarget } from "./todoDialogs";
import { useWorkflowEnvironmentIds } from "./useFeatureBoard";

const SUBMIT_SHORTCUT = {
  key: "enter",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
} as const;

const BRIEF_MAX = 16_000;

const projectKey = (project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${project.environmentId}:${project.id}`;

/** Renders once at the root, so the board, a todo and the palette all open the same dialog. */
export function NewFeatureDialogHost() {
  const target = useAtomValue(newFeatureDialogAtom);
  const workflowEnvironmentIds = useWorkflowEnvironmentIds();
  const railProjectKeys = useBotRailProjectKeys();
  const projects = useProjects()
    .filter(
      (project) =>
        workflowEnvironmentIds.has(project.environmentId) &&
        (railProjectKeys === null || railProjectKeys.has(projectKey(project))),
    )
    .toSorted((a, b) => a.title.localeCompare(b.title));
  if (target === null) return null;
  return <NewFeatureDialog target={target} projects={projects} onClose={closeNewFeatureDialog} />;
}

/**
 * Starts a feature from the board without leaving it: the brief, the project and the workflow,
 * which is what the composer's Workflow picker sends. Roles bring their own models, and the
 * feature gets its own worktree.
 */
function NewFeatureDialog(props: {
  readonly target: NewFeatureTarget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const initial = props.target.project;
  const [selectedKey, setSelectedKey] = useState(
    initial ? `${initial.environmentId}:${initial.projectId}` : null,
  );
  const project =
    props.projects.find((candidate) => projectKey(candidate) === selectedKey) ??
    props.projects[0] ??
    null;
  const library = project ? { environmentId: project.environmentId, input: {} } : null;
  const definitions =
    useEnvironmentQuery(library ? workflowsEnvironment.definitions(library) : null).data ?? [];
  const bots = useEnvironmentQuery(library ? botsEnvironment.list(library) : null).data;
  const defaultWorkflowId = project && bots ? botDefaultWorkflowId(bots, project) : null;
  const [pickedWorkflowId, setPickedWorkflowId] = useState<string | null>(null);
  const workflow =
    definitions.find((definition) => definition.id === pickedWorkflowId) ??
    definitions.find((definition) => definition.id === defaultWorkflowId) ??
    definitions[0] ??
    null;
  const [brief, setBrief] = useState(props.target.brief ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One ID per dialog, so a retried submit reuses the feature it already created.
  const [featureId] = useState(() => `feature:${randomUUID()}`);

  const text = brief.trim();
  const submit = async () => {
    if (!project || !workflow || !text || busy) return;
    if (text.length > BRIEF_MAX) {
      setError("Keep the brief under 16,000 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    const target = { environmentId: project.environmentId };
    const fail = (result: AtomCommandResult<unknown, unknown>) => {
      setBusy(false);
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error
          ? failure.message.replace(/^\w*Error: /, "")
          : "The feature could not be started.",
      );
    };
    const created = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.create,
      {
        ...target,
        input: {
          id: featureId,
          projectId: project.id,
          title: text.split("\n")[0]!.trim().slice(0, 120) || "New feature",
          brief: text,
          workflowId: workflow.id,
          autoTitle: true,
          // A feature's stages share one workspace, so it gets its own worktree.
          workspace: "worktree",
        },
      },
      { reportFailure: false },
    );
    if (created._tag !== "Success") return fail(created);
    // A feature started from a todo works on it, so its board card and threads name it.
    if (props.target.issueRef) {
      const linked = await runAtomCommand(
        appAtomRegistry,
        featuresEnvironment.setIssue,
        { ...target, input: { projectId: project.id, featureId, url: props.target.issueRef } },
        { reportFailure: false },
      );
      if (linked._tag !== "Success") return fail(linked);
    }
    const started = await runAtomCommand(
      appAtomRegistry,
      featuresEnvironment.start,
      { ...target, input: { projectId: project.id, featureId } },
      { reportFailure: false },
    );
    if (started._tag !== "Success") return fail(started);
    setBusy(false);
    toastManager.add({ type: "success", title: "Feature started", description: workflow.name });
    props.onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  const openLibrary = () => {
    props.onClose();
    void navigate({ to: "/library", search: {} });
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-col gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={onKeyDown}
        >
          <DialogTitle className="ms-1">New feature</DialogTitle>
          <ComposerSurface.Shell>
            <ComposerSurface.Main>
              <div className="rounded-2xl">
                <textarea
                  autoFocus
                  aria-label="Brief"
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="What should the crew build? The first line becomes the title."
                  className="block max-h-[50vh] min-h-28 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-base leading-relaxed outline-none [field-sizing:content] placeholder:text-placeholder sm:text-sm"
                />
                <div className="flex items-center gap-1 px-2.5 pb-2.5">
                  {props.projects.length > 1 ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <ComposerControl
                            size="sm"
                            aria-label={`Project: ${project?.title ?? ""}`}
                          />
                        }
                      >
                        <ComposerControlIcon icon={FolderIcon} />
                        <span data-composer-control-label className="max-w-40 truncate">
                          {project?.title}
                        </span>
                      </MenuTrigger>
                      <MenuPopup side="top" align="start" className="min-w-48">
                        <MenuGroup>
                          <MenuGroupLabel>Project</MenuGroupLabel>
                          <MenuRadioGroup
                            value={project ? projectKey(project) : ""}
                            onValueChange={(value: string) => {
                              setSelectedKey(value);
                              setPickedWorkflowId(null);
                            }}
                          >
                            {props.projects.map((candidate) => (
                              <MenuRadioItem
                                key={projectKey(candidate)}
                                value={projectKey(candidate)}
                                closeOnClick
                              >
                                {candidate.title}
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </MenuGroup>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                  <WorkflowMenu
                    definitions={definitions}
                    workflow={workflow}
                    size="sm"
                    onPick={(workflowId) => setPickedWorkflowId(workflowId)}
                    onManageWorkflows={openLibrary}
                  />
                  {workflow && project ? (
                    <CrewMenu
                      environmentId={project.environmentId}
                      workflow={workflow}
                      size="sm"
                      onEditCrew={openLibrary}
                    />
                  ) : null}
                  <span className="flex-1" />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="submit"
                          aria-label="Start feature"
                          disabled={busy || !project || !workflow || !text}
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-transform duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 hover:scale-105 hover:bg-message-action-hover disabled:pointer-events-none disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none"
                        />
                      }
                    >
                      {busy ? (
                        <Spinner size="sm" aria-hidden="true" />
                      ) : (
                        <ArrowUpIcon className="size-4" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      Start feature <Kbd>{formatShortcutLabel(SUBMIT_SHORTCUT)}</Kbd>
                    </TooltipPopup>
                  </Tooltip>
                </div>
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Shell>
          {error ? (
            <p role="alert" className="ps-1 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </DialogPopup>
    </Dialog>
  );
}
