import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

interface FeatureTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId: ProjectId; readonly featureId: string };
}

/** Feature records, the Features board, and the actions on a feature card. */
export function createFeatureAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: {
    /** Re-reads a project's board while it is read, whenever this signal changes. */
    readonly boardRefreshTrigger?: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    }) => Atom.Atom<unknown> | undefined;
  } = {},
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:list",
    tag: WS_METHODS.featuresList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:detail",
    tag: WS_METHODS.featuresGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  /** One project's board cards. Pass `boardRefreshTrigger` to re-read it when its threads move. */
  const board = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:board",
    tag: WS_METHODS.featuresBoard,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    ...(options.boardRefreshTrigger === undefined
      ? {}
      : { refreshTrigger: options.boardRefreshTrigger }),
  });
  /**
   * One project's repository issues and milestones. The server shares each read for half a
   * minute, so this only needs to be as fresh as that.
   */
  const issues = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:list",
    tag: WS_METHODS.issuesList,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  });
  /** One project's Bosun tickets. Writes refresh it, so it only needs the board's pace. */
  const tickets = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tickets:list",
    tag: WS_METHODS.ticketsList,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  });
  /** One issue with its description and comments, read from the host when a detail view opens. */
  const issueDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesGet,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
  });
  /** Re-reads the project's todos after a write, and the issue's detail when one is named. */
  const refreshTodos = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId; readonly number?: number };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      const { environmentId } = target;
      const { projectId, number } = target.input;
      registry.refresh(issues({ environmentId, input: { projectId } }));
      registry.refresh(tickets({ environmentId, input: { projectId } }));
      if (number !== undefined) {
        registry.refresh(issueDetail({ environmentId, input: { projectId, number } }));
      }
    });
  const todoCommand = <TTag extends TodoCommandTag>(tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:todos:${tag}`,
      tag,
      onSuccess: refreshTodos,
    });

  const refresh = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    featureId: string,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: { projectId } }));
      registry.refresh(board({ environmentId, input: { projectId } }));
      registry.refresh(detail({ environmentId, input: { projectId, featureId } }));
    });
  const refreshTarget = (target: FeatureTarget, registry: AtomRegistry.AtomRegistry) =>
    refresh(target.environmentId, target.input.projectId, target.input.featureId, registry);
  const action = <TTag extends FeatureActionTag>(tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:features:${tag}`,
      tag,
      onSuccess: refreshTarget,
    });

  return {
    list,
    detail,
    board,
    issues,
    tickets,
    issueDetail,
    createIssue: todoCommand(WS_METHODS.issuesCreate),
    setIssueState: todoCommand(WS_METHODS.issuesSetState),
    createTicket: todoCommand(WS_METHODS.ticketsCreate),
    updateTicket: todoCommand(WS_METHODS.ticketsUpdate),
    deleteTicket: todoCommand(WS_METHODS.ticketsDelete),
    /** Files the ticket as an issue on the project's host and deletes the ticket. */
    moveTicketToIssue: todoCommand(WS_METHODS.ticketsMoveToIssue),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:create",
      tag: WS_METHODS.featuresCreate,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.id, registry),
    }),
    /** Reopens a closed feature, or closes one; closing leaves its threads as they are. */
    setStatus: action(WS_METHODS.featuresSetStatus),
    /** Starts the feature's lead on its brief; succeeds with the lead's thread. */
    start: action(WS_METHODS.featuresStart),
    /** Links an issue by its URL; null unlinks it. */
    setIssue: action(WS_METHODS.featuresSetIssue),
  };
}

type TodoCommandTag =
  | typeof WS_METHODS.issuesCreate
  | typeof WS_METHODS.issuesSetState
  | typeof WS_METHODS.ticketsCreate
  | typeof WS_METHODS.ticketsUpdate
  | typeof WS_METHODS.ticketsDelete
  | typeof WS_METHODS.ticketsMoveToIssue;

type FeatureActionTag =
  | typeof WS_METHODS.featuresSetStatus
  | typeof WS_METHODS.featuresStart
  | typeof WS_METHODS.featuresSetIssue;
