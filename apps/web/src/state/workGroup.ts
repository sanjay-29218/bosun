import { useAtomValue } from "@effect/atom-react";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { workGroupOf, type WorkGroup } from "@t3tools/client-runtime/state/work-groups";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

type ThreadWorkGroup = WorkGroup<EnvironmentThreadShell>;

const noWorkGroupAtom = Atom.make((): ThreadWorkGroup | null => null);

/** The same group comes back until one of its threads changes, so readers skip other updates. */
const workGroupAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previousThreads: ReadonlyArray<EnvironmentThreadShell> = [];
  let previous: ThreadWorkGroup | null = null;
  return Atom.make((get): ThreadWorkGroup | null => {
    const shells = get(environmentThreadShells.threadShellsAtom).filter(
      (shell) => shell.environmentId === ref.environmentId && shell.archivedAt === null,
    );
    const thread = shells.find((shell) => shell.id === ref.threadId);
    const group = thread ? workGroupOf(thread, shells) : null;
    const threads = group ? [group.primary, ...group.children.map((entry) => entry.thread)] : [];
    if (arrayElementsEqual(previousThreads, threads)) return previous;
    previousThreads = threads;
    previous = group;
    return group;
  }).pipe(Atom.withLabel(`web-work-group:${key}`));
});

/** The feature or bot request a thread works on, with all its threads; null for a plain thread. */
export function useWorkGroup(ref: ScopedThreadRef | null): ThreadWorkGroup | null {
  return useAtomValue(ref ? workGroupAtomFamily(threadKey(ref)) : noWorkGroupAtom);
}
