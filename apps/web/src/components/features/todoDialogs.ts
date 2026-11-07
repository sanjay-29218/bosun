import {
  featureIssueRef,
  type EnvironmentId,
  type FeatureIssue,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readLocalApi } from "../../localApi";
import { type IssueSurface, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";

/*
 * What the New todo dialog and the todo sheet show. Both render once at the root; this module
 * stays free of their editors and Markdown so menus and the command palette can open them.
 */

export interface TodoOwner {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/**
 * A ticket by its ID, or an issue by its number in the project's repository. An issue opened from
 * a link carries the link's URL, so one in another repository isn't shown as this one's.
 */
export type TodoTarget = TodoOwner &
  (
    | { readonly ticketId: string }
    | { readonly number: number; readonly url?: string; readonly ticketId?: never }
  );

export interface NewTodoTarget {
  /** The project to start in; the first one when absent. */
  readonly project?: TodoOwner;
}

export const todoDetailAtom = Atom.make<TodoTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:todo-detail"),
);

export const newTodoDialogAtom = Atom.make<NewTodoTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:new-todo-dialog"),
);

export function openTodo(target: TodoTarget): void {
  appAtomRegistry.set(todoDetailAtom, target);
}

export const closeTodo = () => appAtomRegistry.set(todoDetailAtom, null);

export function openNewTodoDialog(target: NewTodoTarget = {}): void {
  appAtomRegistry.set(newTodoDialogAtom, target);
}

export const closeNewTodoDialog = () => appAtomRegistry.set(newTodoDialogAtom, null);

/** The todo a linked issue opens as; null for a tracker key such as `LIN-123`, which opens its site. */
export function featureIssueTodo(owner: TodoOwner, issue: FeatureIssue): TodoTarget | null {
  if (issue.ticketId !== undefined) return { ...owner, ticketId: issue.ticketId };
  return issue.key === undefined ? { ...owner, number: issue.number, url: issue.url } : null;
}

/**
 * Opens a linked issue: in `threadRef`'s right panel when given, else in the todo sheet. A Cmd- or
 * Ctrl-click or middle click opens it on its host instead, as a pull request link does.
 */
export function openFeatureIssue(
  owner: TodoOwner,
  issue: FeatureIssue,
  options: {
    readonly threadRef?: ScopedThreadRef | null;
    readonly event?: Pick<MouseEvent, "metaKey" | "ctrlKey" | "button">;
  } = {},
): void {
  const todo = featureIssueTodo(owner, issue);
  const { event } = options;
  const external = event !== undefined && (event.metaKey || event.ctrlKey || event.button === 1);
  if (todo === null || (external && issue.url)) {
    // A bare tracker key, such as `LIN-123`, has nowhere to open.
    if (issue.url) void readLocalApi()?.shell.openExternal(issue.url);
    return;
  }
  if (options.threadRef) openTodoInPanel(options.threadRef, todo, featureIssueRef(issue));
  else openTodo(todo);
}

/** Opens a todo as a tab in a thread's right panel. */
export function openTodoInPanel(threadRef: ScopedThreadRef, todo: TodoTarget, ref: string): void {
  useRightPanelStore.getState().openIssue(threadRef, {
    environmentId: todo.environmentId,
    projectId: todo.projectId,
    ref,
    ...(todo.ticketId === undefined
      ? { number: todo.number, ...(todo.url === undefined ? {} : { url: todo.url }) }
      : { ticketId: todo.ticketId }),
  });
}

/** The todo an issue tab shows. */
export function issueSurfaceTodo(surface: IssueSurface): TodoTarget {
  const owner = {
    environmentId: surface.environmentId as EnvironmentId,
    projectId: surface.projectId as ProjectId,
  };
  return surface.ticketId === undefined
    ? { ...owner, number: surface.number ?? 0, ...(surface.url ? { url: surface.url } : {}) }
    : { ...owner, ticketId: surface.ticketId };
}
