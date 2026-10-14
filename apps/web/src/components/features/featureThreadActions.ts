import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { FeatureCardState, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featureThreadsEnvironment } from "../../state/featureThreads";
import { featuresEnvironment } from "../../state/features";
import { workflowsEnvironment } from "../../state/workflows";
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

/**
 * Pauses, resumes, cancels or reopens a whole feature from any of its threads' menus. Cancel
 * asks first. The same RPCs the stage thread and the board use.
 */
export async function runFeatureLifecycleAction(
  action: "feature-pause" | "feature-resume" | "feature-cancel" | "feature-reopen",
  target: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly projectId: ProjectId;
    readonly featureId: string;
    readonly title: string;
  },
): Promise<void> {
  if (action === "feature-cancel") {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        `Cancel "${target.title}"?\nIts running stage stops. Reopen the feature to pick it up again.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
  }
  const input = {
    projectId: target.projectId,
    featureId: target.featureId,
    requestId: `${action}:${randomUUID()}`,
  };
  const options = { reportFailure: false } as const;
  const request = { environmentId: target.environmentId, input };
  const result =
    action === "feature-pause"
      ? await runAtomCommand(appAtomRegistry, workflowsEnvironment.pause, request, options)
      : action === "feature-resume"
        ? await runAtomCommand(appAtomRegistry, workflowsEnvironment.resume, request, options)
        : action === "feature-cancel"
          ? await runAtomCommand(appAtomRegistry, workflowsEnvironment.cancel, request, options)
          : await runAtomCommand(appAtomRegistry, featuresEnvironment.reopen, request, options);
  if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not ${action.slice("feature-".length)} ${target.title}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

/**
 * Where a thread's feature stands, read from its current stage thread: the thread itself, or
 * one of `threads`. Null outside a feature or when the stage thread isn't loaded.
 */
export function featureLifecycleFor(
  thread: {
    readonly environmentId: string;
    readonly feature?: { readonly id: string } | null;
    readonly crew?: { readonly current: boolean; readonly state: FeatureCardState } | null;
  },
  threads: Iterable<typeof thread>,
): { readonly state: FeatureCardState } | null {
  if (!thread.feature) return null;
  if (thread.crew?.current) return { state: thread.crew.state };
  for (const other of threads) {
    if (
      other.environmentId === thread.environmentId &&
      other.feature?.id === thread.feature.id &&
      other.crew?.current
    ) {
      return { state: other.crew.state };
    }
  }
  return null;
}
