import type { EnvironmentId, RoleConfig } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import {
  useLibraries,
  useLibraryByEnvironment,
  type EnvironmentLibraryState,
} from "../../state/library";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../../state/environments";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CrewSettingsFrame } from "../settings/CrewSettingsFrame";
import { ROLES_SETTINGS_PATH, WORKFLOWS_SETTINGS_PATH } from "../sidebar/mainAppLocation";
import { LibraryList } from "./LibraryList";
import type { LibrarySearch } from "./librarySearch";
import {
  hasStarterRoles,
  RoleEditorForm,
  useAddStarterRoles,
  useEnvironmentDefaultModel,
} from "./RoleEditor";
import { WorkflowEditorForm } from "./WorkflowEditor";

type LoadedLibrary = EnvironmentLibraryState & {
  readonly roles: NonNullable<EnvironmentLibraryState["roles"]>;
  readonly workflows: NonNullable<EnvironmentLibraryState["workflows"]>;
};

const isLoaded = (state: EnvironmentLibraryState | null): state is LoadedLibrary =>
  state !== null && state.roles !== null && state.workflows !== null;

/**
 * Settings → Workflows or Roles: the list, or the selected workflow's or role's editor, or a new
 * one.
 */
export function LibraryPage({
  kind,
  search,
}: {
  readonly kind: "workflow" | "role";
  readonly search: LibrarySearch;
}) {
  const navigate = useNavigate();
  const libraries = useLibraries();
  const shown = useLibraryByEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const path = kind === "workflow" ? WORKFLOWS_SETTINGS_PATH : ROLES_SETTINGS_PATH;
  const listTitle = kind === "workflow" ? "Workflows" : "Roles";
  const creating = search.new === kind;
  const newEnvironmentId =
    search.environmentId ??
    shown.find((state) => state.environmentId === primaryEnvironmentId)?.environmentId ??
    shown[0]?.environmentId ??
    libraries[0]?.environmentId ??
    null;
  const environmentId = creating ? newEnvironmentId : (search.environmentId ?? null);
  const live = libraries.find((state) => state.environmentId === environmentId) ?? null;
  // An editor's environment can drop out while the user edits; keep showing its last library
  // so a disconnect doesn't throw away unsaved changes.
  const [kept, setKept] = useState<LoadedLibrary | null>(null);
  if (
    isLoaded(live) &&
    (kept?.environmentId !== live.environmentId ||
      kept.roles !== live.roles ||
      kept.workflows !== live.workflows)
  ) {
    setKept(live);
  }
  const library = isLoaded(live)
    ? live
    : kept !== null && kept.environmentId === environmentId
      ? kept
      : null;
  const selectedId = kind === "workflow" ? search.workflowId : search.roleId;
  const workflow =
    kind !== "workflow" || selectedId === undefined
      ? null
      : (library?.workflows.find((candidate) => candidate.id === selectedId) ?? null);
  const role =
    kind !== "role" || selectedId === undefined
      ? null
      : (library?.roles.find((candidate) => candidate.id === selectedId) ?? null);
  const selecting = selectedId !== undefined;

  // Bumped to remount the open form, which discards its draft.
  const [formRevision, setFormRevision] = useState(0);
  const open = (id: string) => {
    if (environmentId === null) return;
    void navigate({
      to: path,
      search: { environmentId, ...(kind === "workflow" ? { workflowId: id } : { roleId: id }) },
      replace: true,
    });
  };
  const close = () => void navigate({ to: path, search: {} });
  const back = { label: listTitle, onBack: close };
  const status =
    environmentId !== null && library === null
      ? live === null
        ? "This environment isn't connected."
        : live.error
      : null;

  if (!creating && !selecting) {
    return (
      <CrewSettingsFrame
        back={null}
        title={listTitle}
        actions={
          libraries.length === 0 ? null : (
            <Button size="sm" onClick={() => void navigate({ to: path, search: { new: kind } })}>
              <PlusIcon />
              {kind === "workflow" ? "New workflow" : "New role"}
            </Button>
          )
        }
      >
        {libraries.length === 0 ? <NoEnvironments /> : <LibraryList kind={kind} />}
      </CrewSettingsFrame>
    );
  }

  if (creating && environmentId !== null) {
    return (
      <CrewSettingsFrame
        back={back}
        title={kind === "workflow" ? "New workflow" : "New role"}
        actions={null}
      >
        <EnvironmentPicker
          libraries={libraries}
          value={environmentId}
          onChange={(next) =>
            void navigate({
              to: path,
              search: { environmentId: next, new: kind },
              replace: true,
            })
          }
        />
        {library === null ? (
          <LibraryStatus status={status} />
        ) : kind === "workflow" ? (
          <NewWorkflow
            key={environmentId}
            environmentId={environmentId}
            roles={library.roles}
            onSaved={open}
            onCancel={close}
          />
        ) : (
          <NewRole
            key={environmentId}
            environmentId={environmentId}
            roles={library.roles}
            onSaved={open}
            onCancel={close}
          />
        )}
      </CrewSettingsFrame>
    );
  }

  if (workflow !== null && library !== null) {
    return (
      <CrewSettingsFrame back={back} title={workflow.name} actions={null}>
        <WorkflowEditorForm
          key={`${library.environmentId}:${workflow.id}:${formRevision}`}
          environmentId={library.environmentId}
          workflow={workflow}
          roles={library.roles}
          onSaved={() => {}}
          onCancel={() => setFormRevision((revision) => revision + 1)}
          onDeleted={close}
        />
      </CrewSettingsFrame>
    );
  }
  if (role !== null && library !== null) {
    return (
      <CrewSettingsFrame back={back} title={role.name} actions={null}>
        <RoleEditorForm
          key={`${library.environmentId}:${role.id}:${formRevision}`}
          environmentId={library.environmentId}
          role={role}
          defaultModel={role.modelSelection}
          onSaved={() => {}}
          onCancel={() => setFormRevision((revision) => revision + 1)}
        />
      </CrewSettingsFrame>
    );
  }
  return (
    <CrewSettingsFrame back={back} title={listTitle} actions={null}>
      {library === null ? (
        <LibraryStatus status={status} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {kind === "workflow" ? "Workflow unavailable" : "Role unavailable"}
            </EmptyTitle>
            <EmptyDescription>
              {kind === "workflow"
                ? "This workflow no longer exists."
                : "This role no longer exists."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </CrewSettingsFrame>
  );
}

function NewRole({
  environmentId,
  roles,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly onSaved: (roleId: string) => void;
  readonly onCancel: () => void;
}) {
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  const starterRoles = useAddStarterRoles(environmentId);
  const [adding, setAdding] = useState(false);
  if (defaultModel === null) {
    return (
      <LibraryStatus status="Set up a provider on this environment to give new roles a model." />
    );
  }
  return (
    <>
      {hasStarterRoles(roles) ? null : (
        <Alert variant="info">
          <UsersIcon />
          <AlertTitle>No starter roles yet</AlertTitle>
          <AlertDescription>
            Add a Feature manager, Planner, Designer, Builder, QA Tester and Reviewer, then change
            each one as you like.
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={adding}
              onClick={() => {
                setAdding(true);
                void starterRoles.add().then(() => setAdding(false));
              }}
            >
              Add starter roles
            </Button>
          </AlertAction>
        </Alert>
      )}
      <RoleEditorForm
        environmentId={environmentId}
        role={null}
        defaultModel={defaultModel}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </>
  );
}

function NewWorkflow({
  environmentId,
  roles,
  onSaved,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly onSaved: (workflowId: string) => void;
  readonly onCancel: () => void;
}) {
  if (!roles.some((role) => role.enabled)) {
    return <LibraryStatus status="Add a role first. A workflow's lead and crew are roles." />;
  }
  return (
    <WorkflowEditorForm
      environmentId={environmentId}
      workflow={null}
      roles={roles}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

/** Where a new workflow or role goes, when more than one environment has a library. */
function EnvironmentPicker({
  libraries,
  value,
  onChange,
}: {
  readonly libraries: ReadonlyArray<EnvironmentLibraryState>;
  readonly value: EnvironmentId;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  const identities = useEnvironmentIdentities();
  if (libraries.length < 2) return null;
  const labelOf = (environmentId: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ?? environmentId;
  return (
    <div className="flex">
      <Select
        value={value}
        onValueChange={(next) => {
          const match = libraries.find((state) => state.environmentId === next);
          if (match) onChange(match.environmentId);
        }}
      >
        <SelectTrigger size="sm" aria-label="Environment">
          <SelectValue>{labelOf(value)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {libraries.map((state) => (
            <SelectItem key={state.environmentId} value={state.environmentId}>
              {labelOf(state.environmentId)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function LibraryStatus({ status }: { readonly status: string | null }) {
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {status ?? "Loading…"}
    </p>
  );
}

function NoEnvironments() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayersIcon />
        </EmptyMedia>
        <EmptyTitle>No environments available</EmptyTitle>
        <EmptyDescription>
          Connect an environment that runs feature crews to edit its workflows and roles.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
