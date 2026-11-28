import { threadAsksYou, threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

let previousKey = "";
let previous: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * Threads asking you something (`threadAsksYou`): approvals, questions and plans ready for
 * review. The same array comes back until that set changes, so readers skip streamed updates.
 */
export const needsYouThreadsAtom = Atom.make((get): ReadonlyArray<EnvironmentThreadShell> => {
  const waiting = get(environmentThreadShells.threadShellsAtom).filter(threadAsksYou);
  const key = waiting
    .map(
      (shell) =>
        `${shell.environmentId}:${shell.id}:${threadNeedsYouKind(shell) ?? "plan"}:${shell.runtime?.updatedAt ?? shell.updatedAt}:${shell.title}`,
    )
    .join("\n");
  if (key !== previousKey) {
    previousKey = key;
    previous = waiting;
  }
  return previous;
}).pipe(Atom.keepAlive, Atom.withLabel("web-needs-you:threads"));
