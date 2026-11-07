import {
  libraryRoleEntries,
  libraryWorkflowEntries,
  roleAvailabilityNote,
  type LibraryRoleEntry,
  type LibraryWorkflowEntry,
} from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, RoleConfig, WorkflowConfig } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { loadedLibraries, useLibraryByEnvironment } from "../../state/library";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { SettingsSection } from "../settings/settingsLayout";
import { ROLES_SETTINGS_PATH, WORKFLOWS_SETTINGS_PATH } from "../sidebar/mainAppLocation";

/** Settings → Workflows' or Roles' list: every shown environment's workflows or roles. */
export function LibraryList({ kind }: { readonly kind: "workflow" | "role" }) {
  const states = useLibraryByEnvironment();
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const libraries = loadedLibraries(states);
  const workflows = libraryWorkflowEntries(libraries);
  const roles = libraryRoleEntries(libraries);
  const rolesByEnvironment = new Map(
    libraries.map((library) => [library.environmentId, library.roles]),
  );
  const workflowsByEnvironment = new Map(
    libraries.map((library) => [library.environmentId, library.workflows]),
  );
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  const showEnvironment = states.length > 1;
  const loading = states.some(
    (state) => (state.roles === null || state.workflows === null) && state.error === null,
  );
  const errors = states.filter((state) => state.error !== null);
  const environmentLabel = (environmentId: EnvironmentId) =>
    showEnvironment ? (labelById.get(environmentId) ?? null) : null;

  if (states.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {connected.length === 0
          ? "No environments connected"
          : "No connected environment runs feature crews"}
      </p>
    );
  }
  const rows =
    kind === "workflow"
      ? workflows.map((entry) => (
          <WorkflowRow
            key={entry.key}
            entry={entry}
            leadName={leadName(entry, rolesByEnvironment)}
            environmentLabel={environmentLabel(entry.environmentId)}
          />
        ))
      : roles.map((entry) => (
          <RoleRow
            key={entry.key}
            entry={entry}
            note={roleAvailabilityNote(
              entry.item,
              workflowsByEnvironment.get(entry.environmentId) ?? [],
            )}
            environmentLabel={environmentLabel(entry.environmentId)}
          />
        ));
  const title = kind === "workflow" ? "Workflows" : "Roles";
  return (
    <SettingsSection title={title} hideTitle>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border/50">{rows}</ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
          {loading
            ? "Loading…"
            : kind === "workflow"
              ? "No workflows yet. A feature follows a workflow: its lead role takes the brief and hands work to its crew."
              : "No roles yet. A workflow's lead and crew are roles."}
        </p>
      )}
      {errors.map((state) => (
        <p key={state.environmentId} className="px-4 py-3 text-sm text-destructive" role="status">
          Could not load {labelById.get(state.environmentId) ?? "an environment"}'s library:{" "}
          {state.error}
        </p>
      ))}
    </SettingsSection>
  );
}

const leadName = (
  entry: LibraryWorkflowEntry,
  rolesByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<RoleConfig>>,
) =>
  rolesByEnvironment.get(entry.environmentId)?.find((role) => role.id === entry.item.leadRoleId)
    ?.name ?? null;

const crewLabel = (workflow: WorkflowConfig) =>
  workflow.crewRoleIds.length === 1 ? "1 crew role" : `${workflow.crewRoleIds.length} crew roles`;

const ROW_CLASS =
  "flex min-w-0 items-center gap-3 px-4 py-2.5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** One workflow: its name, then its lead and how many crew roles it hands work to. */
const WorkflowRow = memo(function WorkflowRow({
  entry,
  leadName,
  environmentLabel,
}: {
  readonly entry: LibraryWorkflowEntry;
  readonly leadName: string | null;
  readonly environmentLabel: string | null;
}) {
  const workflow = entry.item;
  return (
    <li>
      <Link
        to={WORKFLOWS_SETTINGS_PATH}
        search={{ environmentId: entry.environmentId, workflowId: workflow.id }}
        className={ROW_CLASS}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {workflow.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {leadName ? `${leadName} · ${crewLabel(workflow)}` : crewLabel(workflow)}
          </span>
        </span>
        {environmentLabel ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {environmentLabel}
          </span>
        ) : null}
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
});

/** One role: its name, then whether it's off or in no workflow. */
const RoleRow = memo(function RoleRow({
  entry,
  note,
  environmentLabel,
}: {
  readonly entry: LibraryRoleEntry;
  readonly note: string | null;
  readonly environmentLabel: string | null;
}) {
  const role = entry.item;
  return (
    <li>
      <Link
        to={ROLES_SETTINGS_PATH}
        search={{ environmentId: entry.environmentId, roleId: role.id }}
        className={ROW_CLASS}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium text-foreground",
              !role.enabled && "text-muted-foreground",
            )}
          >
            {role.name}
          </span>
          {note ? <span className="truncate text-xs text-muted-foreground">{note}</span> : null}
        </span>
        {environmentLabel ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {environmentLabel}
          </span>
        ) : null}
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
});
