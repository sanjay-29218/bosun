import {
  type EnvironmentId,
  type ProjectId,
  projectHeadquartersThreadId,
  type ProjectManagerPlacementInput,
  type ProjectRemoteBot,
  type ProjectRemoteManager,
} from "@t3tools/contracts";

import { projectOwner } from "./state/botRail.ts";

/**
 * One environment's copy of a project, as a client sees it: where its manager lives, and what
 * decides where it should live when nothing does yet.
 */
export interface ManagerCopy {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The environment's name, as the other copies will show it. */
  readonly label: string;
  readonly remoteManager?: ProjectRemoteManager | null | undefined;
  readonly managerPermittedEnvironmentIds?: ReadonlyArray<EnvironmentId> | null | undefined;
  /** Its manager has a thread that isn't archived. */
  readonly hasManager: boolean;
  /** The environment its bot lives on, or null with no bot. */
  readonly botHome: EnvironmentId | null;
  /** The linked environments its bot may work on, when the client knows them. */
  readonly botPermittedEnvironmentIds: ReadonlyArray<EnvironmentId> | null;
}

/** Whether this copy keeps the project's manager: no other environment's copy holds it. */
const managerLivesHere = (project: {
  readonly remoteManager?: ProjectRemoteManager | null | undefined;
}) => project.remoteManager == null;

/** One copy per machine, on at least two: what placement decides between. */
export const onSeveralMachines = (
  copies: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
) => copies.length > 1 && new Set(copies.map((copy) => copy.environmentId)).size === copies.length;

const sameCopy = (
  home: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  copy: ManagerCopy,
) => home.environmentId === copy.environmentId && home.projectId === copy.projectId;

/**
 * The copy whose manager is the project's: the one every other copy names. Null while the copies
 * disagree, or name one this client doesn't see.
 */
function settledManagerHome(copies: ReadonlyArray<ManagerCopy>): ManagerCopy | null {
  const homes = copies.filter(managerLivesHere);
  if (homes.length !== 1) return null;
  const home = homes[0]!;
  return copies.every(
    (copy) => copy === home || (copy.remoteManager && sameCopy(copy.remoteManager, home)),
  )
    ? home
    : null;
}

/**
 * Where the manager lives when nothing says yet: the copy whose manager already has a thread,
 * else its bot's home. Among several, its bot's home wins, then the lowest environment id, so
 * every client picks the same one.
 */
function defaultManagerHome(copies: ReadonlyArray<ManagerCopy>): ManagerCopy | null {
  const byId = [...copies].sort((left, right) =>
    left.environmentId.localeCompare(right.environmentId),
  );
  const withManager = byId.filter((copy) => copy.hasManager);
  const pool = withManager.length > 0 ? withManager : byId;
  return pool.find((copy) => copy.environmentId === copy.botHome) ?? pool[0] ?? null;
}

/** Where a manager may work until the person says: its bot's machines that hold a copy. */
function defaultManagerPermitted(
  home: ManagerCopy,
  copies: ReadonlyArray<ManagerCopy>,
): EnvironmentId[] {
  const held = new Set(copies.map((copy) => copy.environmentId));
  return (home.botPermittedEnvironmentIds ?? []).filter(
    (environmentId) => environmentId !== home.environmentId && held.has(environmentId),
  );
}

/** The linked environments a home copy's manager works on: its own list, or the default. */
export const managerPermitted = (home: ManagerCopy, copies: ReadonlyArray<ManagerCopy>) =>
  home.managerPermittedEnvironmentIds ?? defaultManagerPermitted(home, copies);

export interface ManagerPlacementWrite {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectManagerPlacementInput;
}

/**
 * The writes that give a project one manager, on `home` (the default when not given): every
 * other copy names it, and it gets the default Can work on list when it has none. A move away
 * from a copy archives that copy's manager thread, so the home's write comes last, once each
 * retired thread is known (`retired`). Nothing when the copies already agree.
 */
export function planManagerPlacement(
  copies: ReadonlyArray<ManagerCopy>,
  chosen?: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): { readonly away: ManagerPlacementWrite[]; readonly home: ManagerPlacementWrite | null } {
  const none = { away: [], home: null };
  // Two checkouts on one machine keep a manager each; placement is between machines.
  if (!onSeveralMachines(copies)) return none;
  // A copy naming one this client doesn't see is someone else's decision to keep.
  if (
    chosen === undefined &&
    copies.some(
      (copy) => copy.remoteManager && !copies.some((other) => sameCopy(copy.remoteManager!, other)),
    )
  ) {
    return none;
  }
  const settled = settledManagerHome(copies);
  const home =
    chosen === undefined
      ? (settled ?? defaultManagerHome(copies))
      : copies.find((copy) => sameCopy(chosen, copy));
  if (home === null || home === undefined) return none;
  const remoteManager: ProjectRemoteManager = {
    environmentId: home.environmentId,
    projectId: home.projectId,
    homeLabel: home.label,
  };
  const away = copies.flatMap((copy): ManagerPlacementWrite[] =>
    copy === home ||
    (copy.remoteManager &&
      sameCopy(copy.remoteManager, home) &&
      copy.remoteManager.homeLabel === home.label)
      ? []
      : [
          {
            environmentId: copy.environmentId,
            input: { projectId: copy.projectId, remoteManager },
          },
        ],
  );
  const needsHome = home.remoteManager != null;
  // Until its bot's list loads, the default isn't known; saving none would stick.
  const needsPermitted =
    home.managerPermittedEnvironmentIds == null &&
    (home.botHome === null || home.botPermittedEnvironmentIds !== null);
  if (away.length === 0 && !needsHome && !needsPermitted) return none;
  return {
    away,
    home:
      needsHome || needsPermitted
        ? {
            environmentId: home.environmentId,
            input: {
              projectId: home.projectId,
              ...(needsHome ? { remoteManager: null } : {}),
              ...(needsPermitted
                ? { permittedEnvironmentIds: defaultManagerPermitted(home, copies) }
                : {}),
            },
          }
        : { environmentId: home.environmentId, input: { projectId: home.projectId } },
  };
}

/**
 * Sends a plan's writes: the copies moving away first, then the home, once per manager thread a
 * move retired so the home's manager hears which one and where. Stops at the first failure and
 * returns it; the copies already written keep the new home, which a retry completes.
 */
export async function applyManagerPlacement<Failure>(
  plan: ReturnType<typeof planManagerPlacement>,
  copies: ReadonlyArray<ManagerCopy>,
  write: (
    placement: ManagerPlacementWrite,
  ) => Promise<
    | { readonly ok: true; readonly retiredThreadId: ProjectManagerRetiredThreadId | null }
    | { readonly ok: false; readonly failure: Failure }
  >,
): Promise<Failure | null> {
  const retired: Array<{
    readonly environmentLabel: string;
    readonly threadId: ProjectManagerRetiredThreadId;
  }> = [];
  for (const placement of plan.away) {
    const result = await write(placement);
    if (!result.ok) return result.failure;
    if (result.retiredThreadId !== null) {
      const copy = copies.find((candidate) => candidate.environmentId === placement.environmentId);
      retired.push({
        environmentLabel: copy?.label ?? placement.environmentId,
        threadId: result.retiredThreadId,
      });
    }
  }
  const { home } = plan;
  if (home === null) return null;
  const changes = Object.keys(home.input).length > 1;
  const notes = retired.length === 0 ? (changes ? [undefined] : []) : retired;
  for (const [index, note] of notes.entries()) {
    const result = await write({
      environmentId: home.environmentId,
      input: {
        ...(index === 0 ? home.input : { projectId: home.input.projectId }),
        ...(note === undefined ? {} : { retired: note }),
      },
    });
    if (!result.ok) return result.failure;
  }
  return null;
}

type ProjectManagerRetiredThreadId = NonNullable<
  ProjectManagerPlacementInput["retired"]
>["threadId"];

/** A project copy as clients list it, with what placement reads. */
export interface PlacedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly botId?: string | null | undefined;
  readonly remoteBot?: ProjectRemoteBot | null | undefined;
  readonly remoteManager?: ProjectRemoteManager | null | undefined;
  readonly managerPermittedEnvironmentIds?: ReadonlyArray<EnvironmentId> | null | undefined;
}

/**
 * The copies of one project for placement. `threads` are the client's thread shells, archived ones
 * included; `botPermitted` is the bot's Can work on list, or null while unknown.
 */
export function managerCopiesOf(input: {
  readonly projects: ReadonlyArray<PlacedProject>;
  readonly labelOf: (environmentId: EnvironmentId) => string | null;
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly archivedAt: string | null;
  }>;
  readonly botPermitted: (owner: {
    readonly environmentId: EnvironmentId;
    readonly botId: string;
  }) => ReadonlyArray<EnvironmentId> | null;
}): ManagerCopy[] {
  const liveManagers = new Set(
    input.threads.flatMap((thread) =>
      thread.archivedAt === null ? [`${thread.environmentId}:${thread.id}`] : [],
    ),
  );
  return input.projects.map((project) => {
    const owner = projectOwner(project);
    return {
      environmentId: project.environmentId,
      projectId: project.id,
      label: input.labelOf(project.environmentId) ?? project.environmentId,
      remoteManager: project.remoteManager ?? null,
      managerPermittedEnvironmentIds: project.managerPermittedEnvironmentIds ?? null,
      hasManager: liveManagers.has(
        `${project.environmentId}:${projectHeadquartersThreadId(project.id)}`,
      ),
      botHome: owner?.environmentId ?? null,
      botPermittedEnvironmentIds: owner === null ? null : input.botPermitted(owner),
    };
  });
}

/**
 * Where a project's manager lives among its copies: the settled home, else the copy that would
 * be. Null for a copy whose manager lives on a machine this client doesn't see.
 */
export function managerHomeAmong(copies: ReadonlyArray<ManagerCopy>): ManagerCopy | null {
  if (copies.length === 1) return copies[0]!.remoteManager == null ? copies[0]! : null;
  if (!onSeveralMachines(copies)) return null;
  const settled = settledManagerHome(copies);
  if (settled !== null) return settled;
  const named = copies.find((copy) => copy.remoteManager != null)?.remoteManager;
  if (named != null && !copies.some((copy) => sameCopy(named, copy))) return null;
  return defaultManagerHome(copies);
}
