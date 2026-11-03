import {
  libraryRoleEntries,
  roleAvailabilityNote,
  type LibraryRoleEntry,
} from "@t3tools/client-runtime/state/library";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LayersIcon, PlusIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { loadedLibraries, useLibraryByEnvironment } from "../../state/library";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { LIBRARY_PATH } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";

/** The sidebar column on the Library destination: every shown environment's roles. */
export function LibrarySidebar() {
  const states = useLibraryByEnvironment();
  const identities = useEnvironmentIdentities();
  const connected = useConnectedEnvironmentIds();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useSearch({
    strict: false,
    select: (search) =>
      typeof search.environmentId === "string" && typeof search.roleId === "string"
        ? `${search.environmentId}:${search.roleId}`
        : null,
  });
  const roles = libraryRoleEntries(loadedLibraries(states));
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  const showEnvironment = states.length > 1;
  const loading = states.some((state) => state.roles === null && state.error === null);
  const errors = states.filter((state) => state.error !== null);
  const unavailable = states.length === 0;
  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  const startNew = () => {
    closeSheet();
    void navigate({ to: LIBRARY_PATH, search: { new: "role" } });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <h2 className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm font-medium text-sidebar-foreground">
              <LayersIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              Library
            </h2>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <div className="flex flex-col gap-4">
            {unavailable ? (
              <p className="px-2 text-xs text-muted-foreground">
                {connected.length === 0
                  ? "No environments connected"
                  : "No connected environment runs feature crews"}
              </p>
            ) : (
              <LibrarySection
                title="Roles"
                newLabel="New role"
                onNew={startNew}
                empty={loading ? null : "No roles yet"}
              >
                {roles.map((entry) => (
                  <RoleRow
                    key={entry.key}
                    entry={entry}
                    selected={entry.key === selected}
                    environmentLabel={
                      showEnvironment ? (labelById.get(entry.environmentId) ?? null) : null
                    }
                    onOpen={closeSheet}
                  />
                ))}
              </LibrarySection>
            )}
            {loading ? (
              <p className="px-2 text-xs text-muted-foreground" role="status">
                Loading the library…
              </p>
            ) : null}
            {errors.map((state) => (
              <p key={state.environmentId} className="px-2 text-xs text-destructive" role="status">
                Could not load {labelById.get(state.environmentId) ?? "an environment"}'s library:{" "}
                {state.error}
              </p>
            ))}
          </div>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function LibrarySection({
  title,
  newLabel,
  onNew,
  empty,
  children,
}: {
  readonly title: string;
  readonly newLabel: string;
  readonly onNew: () => void;
  readonly empty: string | null;
  readonly children: ReadonlyArray<ReactNode>;
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-center gap-1 pb-1 ps-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        <Button size="xs" variant="ghost-muted" aria-label={newLabel} onClick={onNew}>
          <PlusIcon />
          New
        </Button>
      </div>
      {children.length > 0 ? (
        <ul className="flex flex-col gap-0.5">{children}</ul>
      ) : empty ? (
        <p className="px-2 text-xs text-muted-foreground">{empty}</p>
      ) : null}
    </section>
  );
}

const ROW_CLASS =
  "flex min-w-0 flex-col rounded-md px-2 py-1.5 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** One role: its name, then whether it's off or kept off feature crews. */
const RoleRow = memo(function RoleRow({
  entry,
  selected,
  environmentLabel,
  onOpen,
}: {
  readonly entry: LibraryRoleEntry;
  readonly selected: boolean;
  readonly environmentLabel: string | null;
  readonly onOpen: () => void;
}) {
  const { role } = entry;
  const note = roleAvailabilityNote(role);
  return (
    <li>
      <Link
        to={LIBRARY_PATH}
        search={{ environmentId: entry.environmentId, roleId: role.id }}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        className={cn(ROW_CLASS, selected && "bg-sidebar-row-selected")}
      >
        <span
          className={cn(
            "min-w-0 truncate text-sm text-sidebar-foreground",
            !role.enabled && "text-muted-foreground",
          )}
        >
          {role.name}
        </span>
        {note || environmentLabel ? (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {note ? <span className="truncate">{note}</span> : null}
            {environmentLabel ? (
              <span className="ms-auto shrink-0 truncate">{environmentLabel}</span>
            ) : null}
          </span>
        ) : null}
      </Link>
    </li>
  );
});
