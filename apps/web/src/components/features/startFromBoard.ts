import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentFeatureCard } from "@t3tools/client-runtime/state/crew-board";
import { issueKey, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { FEATURE_DELIVERY_WORKFLOW_ID, EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";

import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  readFeaturesPagePreferences,
  updateFeaturesPagePreferences,
} from "./featuresPagePreferences";

export interface BoardWorkflow {
  readonly id: string;
  readonly name: string;
}

/** Issues being started from the board, by `issueKey`, until their feature has a lead. */
const startingTodosAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:starting-todos"),
);

const setStarting = (key: string, starting: boolean) => {
  const next = new Set(appAtomRegistry.get(startingTodosAtom));
  if (starting) next.add(key);
  else next.delete(key);
  appAtomRegistry.set(startingTodosAtom, next);
};

export const useStartingTodos = () => useAtomValue(startingTodosAtom);

const projectKey = (owner: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) => `${owner.environmentId}:${owner.projectId}`;

/** An environment's workflows, for Start with workflow. */
export function useEnvironmentWorkflows(
  environmentId: EnvironmentId | null,
): ReadonlyArray<BoardWorkflow> {
  const workflows =
    useEnvironmentQuery(
      environmentId ? rolesEnvironment.workflows({ environmentId, input: {} }) : null,
    ).data ?? [];
  return workflows.map((workflow) => ({ id: workflow.id, name: workflow.name }));
}

const boardWorkflowsAtom = Atom.family((key: string) =>
  Atom.make(
    (get) =>
      new Map(
        key
          .split("\n")
          .filter(Boolean)
          .map((id) => {
            const environmentId = EnvironmentId.make(id);
            const result = get(rolesEnvironment.workflows({ environmentId, input: {} }));
            return [environmentId, AsyncResult.getOrElse(result, () => [])] as const;
          }),
      ),
  ),
);

export function useBoardWorkflows(environmentIds: ReadonlyArray<EnvironmentId>) {
  return useAtomValue(boardWorkflowsAtom([...new Set(environmentIds)].sort().join("\n")));
}

/** The workflow ▶ Start uses: the last one started from this project's board, else Feature delivery. */
export function pickWorkflow(
  workflows: ReadonlyArray<BoardWorkflow>,
  owner: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): BoardWorkflow {
  const last = readFeaturesPagePreferences().workflowByProject?.[projectKey(owner)];
  return (
    workflows.find((candidate) => candidate.id === last) ??
    workflows.find((candidate) => candidate.id === FEATURE_DELIVERY_WORKFLOW_ID) ?? {
      id: FEATURE_DELIVERY_WORKFLOW_ID,
      name: "Feature delivery",
    }
  );
}

/** The brief the composer would send for a todo: an issue's title and link, or a ticket's text. */
function todoBrief(
  issue: Pick<EnvironmentIssue, "title" | "url" | "number" | "ticketId">,
  description?: string,
) {
  return issue.ticketId
    ? [issue.title, description?.trim(), `Ticket T-${issue.number}`].filter(Boolean).join("\n\n")
    : `${issue.title}\n\n${issue.url}`;
}

/**
 * Starts a feature on a todo without leaving the board, with the composer's create and start
 * calls: a new worktree on the project's own machine.
 */
export function useStartTodo() {
  const navigate = useNavigate();
  return async (
    issue: Pick<
      EnvironmentIssue,
      "environmentId" | "projectId" | "title" | "url" | "number" | "ticketId"
    >,
    workflow: BoardWorkflow,
    description?: string,
    existing?: EnvironmentFeatureCard,
  ): Promise<boolean> => {
    const key = issueKey(issue);
    if (appAtomRegistry.get(startingTodosAtom).has(key)) return false;
    setStarting(key, true);
    try {
      const { environmentId, projectId } = issue;
      const featureId = existing?.featureId ?? `feature:${randomUUID()}`;
      const brief = todoBrief(issue, description);
      const failed = (result: AtomCommandResult<unknown, unknown>) => {
        setStarting(key, false);
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the feature",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      };
      updateFeaturesPagePreferences((current) => ({
        workflowByProject: { ...current.workflowByProject, [projectKey(issue)]: workflow.id },
      }));
      if (!existing) {
        const created = await runAtomCommand(
          appAtomRegistry,
          featuresEnvironment.create,
          {
            environmentId,
            input: {
              id: featureId,
              projectId,
              title: brief.split("\n")[0]!.trim().slice(0, 120) || "New feature",
              brief,
              autoTitle: true,
              workflowId: workflow.id,
              workspace: "worktree",
            },
          },
          { reportFailure: false },
        );
        if (created._tag !== "Success") return failed(created);
      }
      const started = await runAtomCommand(
        appAtomRegistry,
        featuresEnvironment.start,
        { environmentId, input: { projectId, featureId } },
        { reportFailure: false },
      );
      if (started._tag !== "Success") return failed(started);
      setStarting(key, false);
      const leadThreadId = started.value.leadThreadId;
      toastManager.add({
        type: "success",
        title: `Started ${issue.ticketId ? "T-" : "#"}${issue.number} on ${workflow.name}`,
        description: "It's under Working.",
        actionProps: {
          children: "Open",
          onClick: () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, leadThreadId)),
            }),
        },
      });
      return true;
    } catch (error) {
      setStarting(key, false);
      toastManager.add({
        type: "error",
        title: "Could not start the feature",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return false;
    }
  };
}
