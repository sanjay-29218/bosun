import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featureThreadsEnvironment } from "../../state/featureThreads";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openMakeFeatureDialog } from "./MakeFeatureDialog";

/** Menus wait this long for the thread's feature link before showing without it. */
const MENU_WAIT_MS = 500;

/**
 * Whether a thread's menu offers Make it a feature (plain thread) or Detach (a person's thread
 * that is a feature's current stage). Crew threads, older servers and slow answers get neither.
 */
export async function readFeatureMenuState(
  threadRef: ScopedThreadRef,
  projectId: ProjectId,
): Promise<{ readonly isStage: boolean } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MENU_WAIT_MS);
  try {
    const result = await executeAtomQuery(
      appAtomRegistry,
      featureThreadsEnvironment.link({
        environmentId: threadRef.environmentId,
        input: { projectId, threadId: threadRef.threadId },
      }),
      { signal: controller.signal, reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") return null;
    const { stage, attachable } = result.value;
    return attachable ? { isStage: stage?.current === true } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs Make it a feature or Detach from workflow for a thread menu or the command palette. */
export async function runFeatureThreadAction(
  action: "make-feature" | "detach-feature",
  threadRef: ScopedThreadRef,
  thread: { readonly projectId: ProjectId; readonly title: string },
): Promise<void> {
  if (action === "make-feature") {
    openMakeFeatureDialog(threadRef);
    return;
  }
  const api = readLocalApi();
  if (!api) return;
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      [
        `Detach "${thread.title}" from its workflow?`,
        "The thread carries on as a plain thread and the rest of the feature is cancelled. Reopen the feature to reattach it.",
      ].join("\n"),
      { variant: "destructive" },
    ),
  );
  if (confirmed._tag === "Failure" || !confirmed.value) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    featureThreadsEnvironment.detach,
    {
      environmentId: threadRef.environmentId,
      input: {
        projectId: thread.projectId,
        threadId: threadRef.threadId,
        requestId: randomUUID(),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Detached from workflow",
        description: "Reopen the feature from Done to reattach it.",
      }),
    );
  } else if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not detach the thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
