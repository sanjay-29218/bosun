import {
  type EnvironmentId,
  type ImportedFrom,
  type LibraryImportableItem,
  type LibraryImporter,
  type LibraryImportProblem,
  type LibraryItemKind,
  libraryImportState,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Roles and workflows are environment-local, so their ids only mean something with it. */
const libraryItemKey = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;

/** Why a role won't take part in new features, or null when a workflow uses it. */
export function roleAvailabilityNote(
  role: RoleConfig,
  workflows: ReadonlyArray<WorkflowConfig>,
  resolve: MFunctionType = mFallback,
): string | null {
  if (!role.enabled) return resolve(msg("Off", { $context: "a role that is switched off" }));
  const used = workflows.some((workflow) => workflow.crewRoleIds.includes(role.id));
  return used ? null : resolve(msg("Not in a workflow"));
}

export interface EnvironmentLibrary {
  readonly environmentId: EnvironmentId;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly workflows: ReadonlyArray<WorkflowConfig>;
}

interface LibraryEntry<Item> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly item: Item;
}
export type LibraryRoleEntry = LibraryEntry<RoleConfig>;
export type LibraryWorkflowEntry = LibraryEntry<WorkflowConfig>;

/** Every environment's items, sorted by name; one id on two environments sits side by side. */
function libraryEntries<Item extends { readonly id: string; readonly name: string }>(
  environments: ReadonlyArray<EnvironmentLibrary>,
  items: (library: EnvironmentLibrary) => ReadonlyArray<Item>,
): ReadonlyArray<LibraryEntry<Item>> {
  return environments
    .flatMap((library) =>
      items(library).map((item) => ({
        key: libraryItemKey(library.environmentId, item.id),
        environmentId: library.environmentId,
        item,
      })),
    )
    .sort((left, right) =>
      left.item.name.localeCompare(right.item.name, undefined, { sensitivity: "base" }),
    );
}

export const libraryRoleEntries = (environments: ReadonlyArray<EnvironmentLibrary>) =>
  libraryEntries(environments, (library) => library.roles);

export const libraryWorkflowEntries = (environments: ReadonlyArray<EnvironmentLibrary>) =>
  libraryEntries(environments, (library) => library.workflows);

interface Imported {
  readonly revision: number;
  readonly importedFrom: ImportedFrom | null;
}

const problemLine = (problem: LibraryImportProblem, machine: string, resolve: MFunctionType) => {
  switch (problem) {
    case "unreachable":
      return resolve(msg("From {machine} · Couldn't reach it", { machine }));
    case "expired":
      return resolve(msg("From {machine} · Link expired", { machine }));
    case "denied":
      return resolve(msg("From {machine} · Needs a full-access link", { machine }));
    case "outdated":
      return resolve(msg("From {machine} · Update Bosun there", { machine }));
    case "removed":
      return resolve(msg("From {machine} · Removed there", { machine }));
    case "notLinked":
      return resolve(msg("From {machine} · Link it to get updates", { machine }));
  }
};

/** The muted line under an imported workflow or role in a list; null for one made here. */
export function libraryImportLine(item: Imported, resolve: MFunctionType = mFallback) {
  const from = item.importedFrom;
  if (from === null) return null;
  const machine = from.label;
  if (from.problem !== null) return problemLine(from.problem, machine, resolve);
  return libraryImportState(item).edited
    ? resolve(msg("From {machine} · Changed here", { machine }))
    : resolve(msg("From {machine}", { machine }));
}

export type LibraryImportAction = "take" | "skip" | "detach" | "link";

export interface LibraryImportBanner {
  readonly variant: "default" | "info" | "warning";
  readonly title: string;
  readonly description: string;
  readonly actions: ReadonlyArray<LibraryImportAction>;
}

const problemTitle = (problem: LibraryImportProblem, machine: string, resolve: MFunctionType) => {
  switch (problem) {
    case "unreachable":
      return resolve(msg("Couldn't reach {machine}", { machine }));
    case "expired":
      return resolve(msg("Link to {machine} expired", { machine }));
    case "denied":
      return resolve(msg("{machine} needs a full-access link", { machine }));
    case "outdated":
      return resolve(msg("Update Bosun on {machine}", { machine }));
    case "removed":
      return resolve(msg("Removed on {machine}", { machine }));
    case "notLinked":
      return resolve(msg("Link {machine} to get its updates", { machine }));
  }
};

/** What an imported workflow's or role's editor says about its source, and what it offers. */
export function libraryImportBanner(
  kind: LibraryItemKind,
  item: Imported,
  resolve: MFunctionType = mFallback,
): LibraryImportBanner | null {
  const from = item.importedFrom;
  if (from === null) return null;
  const machine = from.label;
  const { edited, updateAvailable } = libraryImportState(item);
  if (from.problem === "notLinked") {
    return {
      variant: "info",
      title: problemTitle(from.problem, machine, resolve),
      description: resolve(
        msg("This came from {machine}. Link {machine} from this machine to see its updates.", {
          machine,
        }),
      ),
      actions: ["link", "detach"],
    };
  }
  if (from.problem !== null) {
    return {
      variant: "warning",
      title: problemTitle(from.problem, machine, resolve),
      description:
        from.problem === "removed"
          ? resolve(msg("It keeps working here, as your copy."))
          : resolve(msg("It keeps working here. Its updates show again once this is fixed.")),
      actions: ["detach"],
    };
  }
  if (updateAvailable) {
    const description =
      kind === "role"
        ? edited
          ? resolve(
              msg(
                "Taking it replaces this role's name, instructions, model and fallback model, and your changes here.",
              ),
            )
          : resolve(
              msg("Taking it replaces this role's name, instructions, model and fallback model."),
            )
        : edited
          ? resolve(
              msg(
                "Taking it replaces this workflow's name, instructions and crew, and your changes here.",
              ),
            )
          : resolve(msg("Taking it replaces this workflow's name, instructions and crew."));
    return {
      variant: "info",
      title: resolve(msg("Update available from {machine}", { machine })),
      description,
      actions: ["take", "skip"],
    };
  }
  return edited
    ? {
        variant: "default",
        title: resolve(msg("Imported from {machine} · changed here", { machine })),
        description: resolve(
          msg("Your edits stay until you take an update from {machine}.", { machine }),
        ),
        actions: ["detach"],
      }
    : {
        variant: "default",
        title: resolve(msg("Imported from {machine}", { machine })),
        description: resolve(
          msg("You can edit it here. You'll see Update available when {machine} changes it.", {
            machine,
          }),
        ),
        actions: ["detach"],
      };
}

/** How one machine that imported it stands, for the source's "Imported on" list. */
export function libraryImporterLine(
  importer: LibraryImporter,
  revision: number,
  when: string,
  resolve: MFunctionType = mFallback,
) {
  if (importer.pending) return resolve(msg("Update waiting · last seen {when}", { when }));
  if (importer.edited) return resolve(msg("Changed there · checked {when}", { when }));
  return importer.revision === revision
    ? resolve(msg("Has this version · checked {when}", { when }))
    : resolve(msg("Has an older version · checked {when}", { when }));
}

export const libraryImportKey = (item: Pick<LibraryImportableItem, "kind" | "id">) =>
  `${item.kind}\n${item.id}`;

/**
 * What an import of the ticked items brings: a ticked workflow also brings the roles it names
 * that this machine lacks (`neededBy`, by the workflow's name), and one already current stays.
 */
export function libraryImportSelection(
  items: ReadonlyArray<LibraryImportableItem>,
  ticked: ReadonlySet<string>,
) {
  const roles = items.filter((item) => item.kind === "role");
  const neededBy = new Map<string, string>();
  for (const workflow of items) {
    if (workflow.kind !== "workflow" || !ticked.has(libraryImportKey(workflow))) continue;
    for (const roleId of workflow.crewRoleIds) {
      const role = roles.find((candidate) => candidate.id === roleId);
      if (role?.status === "new" && !neededBy.has(role.id)) neededBy.set(role.id, workflow.name);
    }
  }
  const chosen = items.filter(
    (item) =>
      item.status !== "current" &&
      (ticked.has(libraryImportKey(item)) || (item.kind === "role" && neededBy.has(item.id))),
  );
  return {
    neededBy: neededBy as ReadonlyMap<string, string>,
    chosen,
    replacing: chosen.filter((item) => item.status === "replaces"),
  };
}

/** Updates start ticked; nothing else does. */
export const libraryImportDefaults = (items: ReadonlyArray<LibraryImportableItem>) =>
  new Set(items.filter((item) => item.status === "update").map(libraryImportKey));

/** The import button: how many workflows and roles it brings. */
export function libraryImportButtonLabel(
  chosen: ReadonlyArray<Pick<LibraryImportableItem, "kind">>,
  resolve: MFunctionType = mFallback,
) {
  const workflows = chosen.filter((item) => item.kind === "workflow").length;
  const roles = chosen.length - workflows;
  if (workflows === 0) {
    return resolve(
      msg("{roles, plural, one {Import {roles} role} other {Import {roles} roles}}", { roles }),
    );
  }
  if (roles === 0) {
    return resolve(
      msg(
        "{workflows, plural, one {Import {workflows} workflow} other {Import {workflows} workflows}}",
        { workflows },
      ),
    );
  }
  return resolve(
    msg(
      "{workflows, plural, one {Import {workflows} workflow} other {Import {workflows} workflows}}, {roles, plural, one {{roles} role} other {{roles} roles}}",
      { workflows, roles },
    ),
  );
}

/** What importing with replace overwrites here, named. */
export function libraryReplaceWarning(
  replacing: ReadonlyArray<LibraryImportableItem>,
  machine: string,
  resolve: MFunctionType = mFallback,
) {
  return resolve(
    msg(
      "Replaces {count} of {machine}''s workflows and roles: {names}. Features already running keep theirs.",
      {
        count: replacing.length,
        machine,
        names: replacing.map((item) => item.replaces?.name ?? item.name).join(", "),
      },
    ),
  );
}
