import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState, type KeyboardEvent } from "react";

import { formatShortcutLabel } from "../../keybindings";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { botDefaultWorkflowId } from "../crew/crewDraftStore";
import { InstructionsEditor } from "../InstructionsEditor";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

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

/**
 * Starts a feature from the board without leaving it: the brief, the project and the workflow,
 * which is what the composer's Workflow picker sends. Roles bring their own models, and the
 * feature gets its own worktree.
 */
export function NewFeatureDialog(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly initialProject: EnvironmentProject | null;
  readonly onClose: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState(
    props.initialProject ? projectKey(props.initialProject) : null,
  );
  const project =
    props.projects.find((candidate) => projectKey(candidate) === selectedKey) ??
    props.projects[0] ??
    null;
  const library = project ? { environmentId: project.environmentId, input: {} } : null;
  const definitions =
    useEnvironmentQuery(library ? workflowsEnvironment.definitions(library) : null).data ?? [];
  const bots = useEnvironmentQuery(library ? botsEnvironment.list(library) : null).data;
  const roles = useEnvironmentQuery(library ? rolesEnvironment.roles(library) : null).data;
  const defaultWorkflowId = project && bots ? botDefaultWorkflowId(bots, project) : null;
  const [pickedWorkflowId, setPickedWorkflowId] = useState<string | null>(null);
  const workflow =
    definitions.find((definition) => definition.id === pickedWorkflowId) ??
    definitions.find((definition) => definition.id === defaultWorkflowId) ??
    definitions[0] ??
    null;
  const [brief, setBrief] = useState("");
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

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={onKeyDown}
        >
          <DialogHeader>
            <DialogTitle>New feature</DialogTitle>
            <DialogDescription>
              The brief goes to the workflow&apos;s first stage. The feature works in its own
              worktree, and each role uses the model set for it in the Library.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {props.projects.length > 1 ? (
                  <Select
                    value={project ? projectKey(project) : ""}
                    onValueChange={(value) => {
                      if (value === null) return;
                      setSelectedKey(value);
                      setPickedWorkflowId(null);
                    }}
                  >
                    <SelectTrigger aria-label="Project" size="sm" className="w-48">
                      <SelectValue>{project?.title}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {props.projects.map((candidate) => (
                        <SelectItem key={projectKey(candidate)} value={projectKey(candidate)}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                <Select
                  value={workflow?.id ?? ""}
                  onValueChange={(value) => {
                    if (value !== null) setPickedWorkflowId(value);
                  }}
                >
                  <SelectTrigger aria-label="Workflow" size="sm" className="w-64">
                    <SelectValue>{workflow?.name ?? "No workflows"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {definitions.map((definition) => {
                      const stages = orderWorkflowStages(definition).length;
                      return (
                        <SelectItem key={definition.id} value={definition.id}>
                          {definition.name} · {stages} {stages === 1 ? "stage" : "stages"}
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </div>
              {workflow ? (
                // Read-only, like the composer's Crew menu: models are set per role in the Library.
                <ul aria-label="Crew" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {Object.entries(workflow.roles).map(([slot, entry]) => {
                    const role = roles?.find((item) => item.id === entry.roleId);
                    return (
                      <li key={slot} className="flex gap-1.5">
                        <span>{role?.name ?? formatStageName(slot)}</span>
                        <span className="text-muted-foreground">
                          {role?.modelSelection.model ?? ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <InstructionsEditor
                label="Brief"
                value={brief}
                onChange={setBrief}
                placeholder="What should the crew build? The first line becomes the title."
                size="lg"
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !project || !workflow || !text}>
              Start feature
              <Kbd>{formatShortcutLabel(SUBMIT_SHORTCUT)}</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
