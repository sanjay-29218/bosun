import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CircleDotIcon, NotebookTextIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { formatShortcutLabel } from "../../keybindings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useBotRailProjectKeys } from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
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
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  readFeaturesPagePreferences,
  saveFeaturesPagePreferences,
} from "./featuresPagePreferences";
import { closeNewTodoDialog, newTodoDialogAtom, type NewTodoTarget } from "./todoDialogs";
import { useWorkflowEnvironmentIds } from "./useFeatureBoard";

type TodoKind = "ticket" | "issue";

const SUBMIT_SHORTCUT = {
  key: "enter",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
} as const;

const projectKey = (project: { readonly environmentId: EnvironmentId; readonly id: ProjectId }) =>
  `${project.environmentId}:${project.id}`;

export function NewTodoDialogHost() {
  const target = useAtomValue(newTodoDialogAtom);
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
  return <NewTodoDialog target={target} projects={projects} />;
}

function NewTodoDialog(props: {
  readonly target: NewTodoTarget;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const initial = props.target.project;
  const [selectedKey, setSelectedKey] = useState(
    initial ? `${initial.environmentId}:${initial.projectId}` : null,
  );
  const project =
    props.projects.find((candidate) => projectKey(candidate) === selectedKey) ??
    props.projects[0] ??
    null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Bumped after a create with Create more on, so the editor starts empty again.
  const [editorKey, setEditorKey] = useState(0);
  const [preferredKind, setPreferredKind] = useState<TodoKind>(
    () => readFeaturesPagePreferences().newTodoKind ?? "ticket",
  );
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const issues = useEnvironmentQuery(
    project
      ? featuresEnvironment.issues({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  const repository = issues.data?.unavailable === null ? issues.data.repository : null;
  const kind: TodoKind = repository ? preferredKind : "ticket";

  const chooseKind = (next: TodoKind) => {
    setPreferredKind(next);
    saveFeaturesPagePreferences({ ...readFeaturesPagePreferences(), newTodoKind: next });
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!project || !trimmed || busy) return;
    setBusy(true);
    setError(null);
    const target = { environmentId: project.environmentId };
    const result =
      kind === "issue"
        ? await runAtomCommand(
            appAtomRegistry,
            featuresEnvironment.createIssue,
            { ...target, input: { projectId: project.id, title: trimmed, body: description } },
            { reportFailure: false },
          )
        : await runAtomCommand(
            appAtomRegistry,
            featuresEnvironment.createTicket,
            { ...target, input: { projectId: project.id, title: trimmed, description } },
            { reportFailure: false },
          );
    setBusy(false);
    if (result._tag === "Success") {
      if (!createMore) {
        closeNewTodoDialog();
        return;
      }
      setCreated(
        "description" in result.value
          ? `Created T-${result.value.number}`
          : `Created #${result.value.number}`,
      );
      setTitle("");
      setDescription("");
      setEditorKey((key) => key + 1);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error
        ? failure.message.replace(/^\w*Error: /, "")
        : "The todo could not be created.",
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  };

  return (
    <Dialog open onOpenChange={(open) => (open || busy ? undefined : closeNewTodoDialog())}>
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
            <DialogTitle>New todo</DialogTitle>
            <DialogDescription>
              {kind === "issue" && repository
                ? `Files an issue in ${repository} as the GitHub account this environment signs in with.`
                : "A ticket stays in Bosun. A feature can work on it like an issue."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {props.projects.length > 1 ? (
                  <Select
                    value={project ? projectKey(project) : ""}
                    onValueChange={(value) => {
                      if (value !== null) setSelectedKey(value);
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
                {repository ? (
                  <ToggleGroup
                    aria-label="Create as"
                    variant="segmented"
                    value={[kind]}
                    onValueChange={(value) => {
                      const next = value[0];
                      if (next === "ticket" || next === "issue") chooseKind(next);
                    }}
                  >
                    <Toggle value="ticket">
                      <NotebookTextIcon aria-hidden />
                      Ticket
                    </Toggle>
                    <Toggle value="issue">
                      <CircleDotIcon aria-hidden />
                      GitHub issue
                    </Toggle>
                  </ToggleGroup>
                ) : null}
              </div>
              <Input
                autoFocus
                aria-label="Title"
                placeholder="Title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setCreated(null);
                }}
              />
              <InstructionsEditor
                key={editorKey}
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="Add a description…"
                size="lg"
              />
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : created ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {created}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <label className="me-auto flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={createMore} onCheckedChange={setCreateMore} />
              Create more
            </label>
            <Button type="button" variant="ghost" onClick={closeNewTodoDialog} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !project || !title.trim()}>
              {kind === "issue" ? "Create issue" : "Create ticket"}
              <Kbd>{formatShortcutLabel(SUBMIT_SHORTCUT)}</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
