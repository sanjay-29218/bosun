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

/** A ticket by its ID, or an issue by its number. */
export type TodoTarget = TodoOwner &
  ({ readonly ticketId: string } | { readonly number: number; readonly ticketId?: never });

export interface NewTodoTarget {
  /** The project to start in; the first one when absent. */
  readonly project?: TodoOwner;
}

/** What the New feature dialog starts from: a project, and a todo's brief and link. */
export interface NewFeatureTarget {
  readonly project?: TodoOwner;
  readonly brief?: string;
  /** The todo the feature works on: a ticket's `T-<number>` or an issue's URL. */
  readonly issueRef?: string;
}

export const newFeatureDialogAtom = Atom.make<NewFeatureTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("features:new-feature-dialog"),
);

export function openNewFeatureDialog(target: NewFeatureTarget = {}): void {
  appAtomRegistry.set(newFeatureDialogAtom, target);
}

export const closeNewFeatureDialog = () => appAtomRegistry.set(newFeatureDialogAtom, null);

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

/** Opens a feature's linked issue: a ticket in the todo sheet, an issue on its host. */
export function openFeatureIssue(owner: TodoOwner, issue: FeatureIssue): void {
  if (issue.ticketId !== undefined) openTodo({ ...owner, ticketId: issue.ticketId });
  else void readLocalApi()?.shell.openExternal(issue.url);
}
