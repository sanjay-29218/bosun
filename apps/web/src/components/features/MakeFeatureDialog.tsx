import { useAtomValue } from "@effect/atom-react";
import { makeFeatureDraft } from "@t3tools/client-runtime/state/featureThreads";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useId, useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { botsEnvironment } from "../../state/bots";
import { randomUUID } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { featureThreadsEnvironment } from "../../state/featureThreads";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Which thread the dialog is open for. Set by the thread menus and the command palette, and
 * rendered once at the root so the dialog outlives a palette or menu that closes on select.
 */
const makeFeatureDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:make-feature-dialog-thread"),
);

export function openMakeFeatureDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(makeFeatureDialogThreadAtom, threadRef);
}

const close = () => appAtomRegistry.set(makeFeatureDialogThreadAtom, null);

export function MakeFeatureDialogHost() {
  const threadRef = useAtomValue(makeFeatureDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  if (threadRef === null || thread === null) return null;
  return <MakeFeatureDialog key={threadRef.threadId} threadRef={threadRef} thread={thread} />;
}

type ThreadShell = NonNullable<ReturnType<typeof useThreadShell>>;

function MakeFeatureDialog({
  threadRef,
  thread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: ThreadShell;
}) {
  const id = useId();
  const target = { environmentId: threadRef.environmentId, input: { projectId: thread.projectId } };
  const definitions = useEnvironmentQuery(workflowsEnvironment.definitions(target));
  const configuration = useEnvironmentQuery(botsEnvironment.configuration(target));
  const workflows = definitions.data ?? [];
  const canAttach = useAtomValue(
    featureThreadsEnvironment.attach.permissionAtom(threadRef.environmentId),
  );
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [stageId, setStageId] = useState<string | null>(null);
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One feature ID per dialog, so a retried submit returns the same feature.
  const [featureId] = useState(() => `feature:${randomUUID()}`);

  const workflow = workflows.find((item) => item.id === workflowId) ?? workflows[0] ?? null;
  const roles = useMemo(
    () =>
      new Map(
        (configuration.data?.templates ?? []).map((template) => [
          template.id,
          { name: template.name, model: template.modelSelection.model },
        ]),
      ),
    [configuration.data],
  );
  const draft = workflow
    ? makeFeatureDraft(workflow, stageId ?? workflow.start, roles)
    : { stages: [], stage: null, next: null };
  const stage = draft.stage ?? draft.stages[0] ?? null;

  const submit = async () => {
    if (!workflow || !stage || !title.trim()) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      featureThreadsEnvironment.attach,
      {
        environmentId: threadRef.environmentId,
        input: {
          featureId,
          projectId: thread.projectId,
          threadId: threadRef.threadId,
          workflowId: workflow.id,
          stageId: stage.stepId,
          title: title.trim(),
        },
      },
      { reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Success") {
      close();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Made it a feature",
          description: `This thread is ${stage.label} · stage ${stage.index} of ${stage.total}.`,
        }),
      );
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not make the feature.");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Make it a feature</DialogTitle>
            <DialogDescription>
              This thread becomes the stage you pick. Earlier stages are marked skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {workflows.length === 0 ? (
              <p className="text-muted-foreground">
                {definitions.isPending
                  ? "Loading workflows…"
                  : (definitions.error ??
                    "No workflows yet. Add one in the project's Workflows settings.")}
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-workflow`}>
                  Workflow
                  <Select
                    value={workflow?.id ?? null}
                    items={Object.fromEntries(workflows.map((item) => [item.id, item.name]))}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      setWorkflowId(value);
                      setStageId(null);
                    }}
                  >
                    <SelectTrigger id={`${id}-workflow`} className="min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {workflows.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Label>
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-stage`}>
                  This thread is
                  <Select
                    value={stage?.stepId ?? null}
                    items={Object.fromEntries(
                      draft.stages.map((item) => [
                        item.stepId,
                        `${item.label} · stage ${item.index} of ${item.total}`,
                      ]),
                    )}
                    onValueChange={(value) => {
                      if (typeof value === "string") setStageId(value);
                    }}
                  >
                    <SelectTrigger id={`${id}-stage`} className="min-w-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {draft.stages.map((item) => (
                        <SelectItem key={item.stepId} value={item.stepId}>
                          {item.label} · stage {item.index} of {item.total}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Label>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Next</span>
                  <span className="text-muted-foreground">
                    {draft.next
                      ? [
                          draft.next.gated
                            ? `Approval, then ${draft.next.label}`
                            : draft.next.label,
                          draft.next.role?.name,
                          draft.next.role?.model,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Nothing: this is the last stage."}
                  </span>
                </div>
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-title`}>
                  Title
                  <Input
                    nativeInput
                    id={`${id}-title`}
                    required
                    maxLength={200}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Label>
              </div>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canAttach || busy || !workflow || !stage || !title.trim()}
            >
              Make feature
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
