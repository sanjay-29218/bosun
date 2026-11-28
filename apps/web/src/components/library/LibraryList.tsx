import {
  libraryImportLine,
  libraryRoleEntries,
  libraryWorkflowEntries,
  roleAvailabilityNote,
  type LibraryRoleEntry,
  type LibraryWorkflowEntry,
} from "@t3tools/client-runtime/state/library";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, libraryImportState, type WorkflowConfig } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import type { MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { loadedLibraries, useLibraryByEnvironment } from "../../state/library";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { rolesEnvironment } from "../../state/roles";
import { SettingsSection } from "../settings/settingsLayout";
import { ROLES_SETTINGS_PATH, WORKFLOWS_SETTINGS_PATH } from "../sidebar/mainAppLocation";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { useSaveRole } from "./RoleEditor";

/** Settings → Workflows' or Roles' list: every shown environment's workflows or roles. */
export function LibraryList({ kind }: { readonly kind: "workflow" | "role" }) {
  const gt = useGT();
  const m = useMessages();
  const states = useLibraryByEnvironment();
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const libraries = loadedLibraries(states);
  const workflows = libraryWorkflowEntries(libraries);
  const roles = libraryRoleEntries(libraries);
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
        {connected.length === 0 ? (
          <T>No environments connected</T>
        ) : (
          <T>No connected environment runs feature crews</T>
        )}
      </p>
    );
  }
  const rows =
    kind === "workflow"
      ? workflows.map((entry) => (
          <WorkflowRow
            key={entry.key}
            entry={entry}
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
              m,
            )}
            environmentLabel={environmentLabel(entry.environmentId)}
          />
        ));
  const title = kind === "workflow" ? gt("Workflows") : gt("Roles");
  return (
    <SettingsSection title={title} hideTitle>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border/50">{rows}</ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
          {loading ? (
            <T>Loading…</T>
          ) : kind === "workflow" ? (
            <T>
              No workflows yet. A feature follows a workflow: its lead takes the brief and hands
              work to the workflow's crew.
            </T>
          ) : (
            <T>No roles yet. A workflow's crew are roles.</T>
          )}
        </p>
      )}
      {errors.map((state) => {
        const label = labelById.get(state.environmentId);
        return (
          <p key={state.environmentId} className="px-4 py-3 text-sm text-destructive" role="status">
            {label === undefined ? (
              <T>
                Could not load an environment's library: <Var>{state.error}</Var>
              </T>
            ) : (
              <T>
                Could not load <Var>{label}</Var>'s library: <Var>{state.error}</Var>
              </T>
            )}
          </p>
        );
      })}
    </SettingsSection>
  );
}

const crewLabel = (workflow: WorkflowConfig, resolve: MessageResolver) =>
  resolve(
    msg("{count, plural, one {{count} crew role} other {{count} crew roles}}", {
      count: workflow.crewRoleIds.length,
    }),
  );

const ROW_CLASS =
  "flex min-w-0 items-center gap-3 px-4 py-2.5 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** One workflow: its name, then how many crew roles it hands work to. */
const WorkflowRow = memo(function WorkflowRow({
  entry,
  environmentLabel,
}: {
  readonly entry: LibraryWorkflowEntry;
  readonly environmentLabel: string | null;
}) {
  const workflow = entry.item;
  const m = useMessages();
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
            {[crewLabel(workflow, m), libraryImportLine(workflow, m)]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
        </span>
        <UpdateBadge item={workflow} />
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

/**
 * One role: its name, then whether it's off or in no workflow, and its on switch. Turning a role
 * off retires it: new features skip it, and running ones keep it.
 */
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
  const gt = useGT();
  const m = useMessages();
  const importLine = libraryImportLine(role, m);
  const save = useSaveRole(entry.environmentId);
  const canEdit = useAtomValue(rolesEnvironment.update.permissionAtom(entry.environmentId));
  const [saving, setSaving] = useState(false);
  return (
    <li className="relative flex min-w-0 items-center gap-3 px-4 py-2.5 hover:bg-accent/40">
      <Link
        to={ROLES_SETTINGS_PATH}
        search={{ environmentId: entry.environmentId, roleId: role.id }}
        aria-label={role.name}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium text-foreground",
            !role.enabled && "text-muted-foreground",
          )}
        >
          {role.name}
        </span>
        {note || importLine ? (
          <span className="truncate text-xs text-muted-foreground">
            {[note, importLine].filter((part) => part).join(" · ")}
          </span>
        ) : null}
      </span>
      <UpdateBadge item={role} />
      {environmentLabel ? (
        <span className="pointer-events-none shrink-0 truncate text-xs text-muted-foreground">
          {environmentLabel}
        </span>
      ) : null}
      {/* Above the row's link, so a toggle doesn't open the role. */}
      <span className="relative flex">
        <Switch
          aria-label={gt("New features use {name}", { name: role.name })}
          checked={role.enabled}
          disabled={!canEdit || saving}
          onCheckedChange={(enabled) => {
            setSaving(true);
            void save(role, { enabled }).then(() => setSaving(false));
          }}
        />
      </span>
      <ChevronRightIcon
        aria-hidden
        className="pointer-events-none size-4 shrink-0 text-muted-foreground"
      />
    </li>
  );
});

/** An imported one whose source has a newer version. */
function UpdateBadge({ item }: { readonly item: Parameters<typeof libraryImportState>[0] }) {
  if (!libraryImportState(item).updateAvailable) return null;
  return (
    <Badge variant="info" size="sm" className="pointer-events-none shrink-0">
      <T>Update available</T>
    </Badge>
  );
}
