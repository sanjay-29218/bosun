import type { EnvironmentId, FeatureIssue, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readLocalApi } from "../../localApi";
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

/** Opens a feature's linked issue in the todo sheet; a tracker key such as `LIN-123` on its site. */
export function openFeatureIssue(owner: TodoOwner, issue: FeatureIssue): void {
  if (issue.ticketId !== undefined) openTodo({ ...owner, ticketId: issue.ticketId });
  else if (issue.key === undefined) openTodo({ ...owner, number: issue.number, url: issue.url });
  // A bare tracker key, such as `LIN-123`, has nowhere to open.
  else if (issue.url) void readLocalApi()?.shell.openExternal(issue.url);
}
