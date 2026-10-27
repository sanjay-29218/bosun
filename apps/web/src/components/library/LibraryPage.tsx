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
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { LIBRARY_PATH } from "../sidebar/mainAppLocation";
import { LibraryFrame } from "./LibraryFrame";
import type { LibrarySearch } from "./librarySearch";
import { NewWorkflow } from "./NewWorkflow";
import {
  hasStarterRoles,
  RoleActions,
  RoleEditorForm,
  useAddStarterRoles,
  useEnvironmentDefaultModel,
} from "./RoleEditor";
import { WorkflowEditor } from "./WorkflowEditor";

type LoadedLibrary = EnvironmentLibraryState & {
  readonly workflows: NonNullable<EnvironmentLibraryState["workflows"]>;
  readonly roles: NonNullable<EnvironmentLibraryState["roles"]>;
};

const isLoaded = (state: EnvironmentLibraryState | null): state is LoadedLibrary =>
  state !== null && state.workflows !== null && state.roles !== null;

/** The Library destination's main pane: the selected workflow's or role's editor, or a new one. */
export function LibraryPage(search: LibrarySearch) {
  const navigate = useNavigate();
  const libraries = useLibraries();
  const shown = useLibraryByEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const newEnvironmentId =
    search.environmentId ??
    shown.find((state) => state.environmentId === primaryEnvironmentId)?.environmentId ??
    shown[0]?.environmentId ??
    libraries[0]?.environmentId ??
    null;
  const environmentId = search.new ? newEnvironmentId : (search.environmentId ?? null);
  const live = libraries.find((state) => state.environmentId === environmentId) ?? null;
  // An editor's environment can drop out while the user edits; keep showing its last library
  // so a disconnect doesn't throw away unsaved changes.
  const [kept, setKept] = useState<LoadedLibrary | null>(null);
  if (
    isLoaded(live) &&
    (kept?.environmentId !== live.environmentId ||
      kept.workflows !== live.workflows ||
      kept.roles !== live.roles)
  ) {
    setKept(live);
  }
  const library = isLoaded(live)
    ? live
    : kept !== null && kept.environmentId === environmentId
      ? kept
      : null;
  const workflow =
    search.workflowId === undefined
      ? null
      : (library?.workflows.find((candidate) => candidate.id === search.workflowId) ?? null);
  const role =
    search.roleId === undefined
      ? null
      : (library?.roles.find((candidate) => candidate.id === search.roleId) ?? null);
  const selecting = search.workflowId !== undefined || search.roleId !== undefined;

  // Bumped to remount the role form, which discards its draft.
  const [formRevision, setFormRevision] = useState(0);
  const open = (target: Omit<LibrarySearch, "environmentId" | "new">, replace = false) => {
    if (environmentId === null) return;
    void navigate({ to: LIBRARY_PATH, search: { environmentId, ...target }, replace });
  };
  const close = () => void navigate({ to: LIBRARY_PATH, search: {} });

  const title =
    search.new === "workflow"
      ? "New workflow"
      : search.new === "role"
        ? "New role"
        : (workflow?.name ?? role?.name ?? null);
  const status =
    environmentId !== null && library === null
      ? live === null
        ? "This environment isn't connected."
        : live.error
      : null;

  let body;
  if (libraries.length === 0 && library === null) {
    body = <NoEnvironments />;
  } else if (search.new && environmentId !== null) {
    const kind = search.new;
    body = (
      <>
        <EnvironmentPicker
          libraries={libraries}
          value={environmentId}
          onChange={(next) =>
            void navigate({
              to: LIBRARY_PATH,
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
            workflows={library.workflows}
            roles={library.roles}
            onCreated={(workflowId) => open({ workflowId }, true)}
          />
        ) : (
          <NewRole
            key={environmentId}
            environmentId={environmentId}
            roles={library.roles}
            onSaved={(roleId) => open({ roleId }, true)}
            onCancel={close}
          />
        )}
      </>
    );
  } else if (selecting && library === null) {
    body = <LibraryStatus status={status} />;
  } else if (workflow !== null && library !== null) {
    return (
      <WorkflowEditor
        key={`${library.environmentId}:${workflow.id}`}
        title={title}
        environmentId={library.environmentId}
        latest={workflow}
        allWorkflowIds={library.workflows.map((definition) => definition.id)}
        roles={library.roles}
        onOpenWorkflow={(workflowId) => open({ workflowId })}
        onDeleted={close}
      />
    );
  } else if (role !== null && library !== null) {
    return (
      <LibraryFrame
        title={title}
        actions={<RoleActions environmentId={library.environmentId} role={role} />}
      >
        <WorkspacePageContainer>
          <RoleEditorForm
            key={`${library.environmentId}:${role.id}:${formRevision}`}
            environmentId={library.environmentId}
            role={role}
            defaultModel={role.modelSelection}
            onSaved={() => {}}
            onCancel={() => setFormRevision((revision) => revision + 1)}
          />
        </WorkspacePageContainer>
      </LibraryFrame>
    );
  } else if (selecting) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{search.workflowId ? "Workflow unavailable" : "Role unavailable"}</EmptyTitle>
          <EmptyDescription>
            {search.workflowId ? "This workflow no longer exists." : "This role no longer exists."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayersIcon />
          </EmptyMedia>
          <EmptyTitle>Pick a workflow or role</EmptyTitle>
          <EmptyDescription>
            Workflows are the stages a feature goes through, and roles run each stage.
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void navigate({ to: LIBRARY_PATH, search: { new: "workflow" } })}
          >
            <PlusIcon />
            New workflow
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: LIBRARY_PATH, search: { new: "role" } })}
          >
            <PlusIcon />
            New role
          </Button>
        </div>
      </Empty>
    );
  }

  return (
    <LibraryFrame title={title} actions={null}>
      <WorkspacePageContainer>{body}</WorkspacePageContainer>
    </LibraryFrame>
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
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No starter roles yet</EmptyTitle>
            <EmptyDescription>
              Add a Project manager, Planner, Designer, Builder, QA Tester and Reviewer. You can
              change each one afterwards.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            variant="outline"
            disabled={adding}
            onClick={() => {
              setAdding(true);
              void starterRoles.add().then(() => setAdding(false));
            }}
          >
            Add the starter roles
          </Button>
        </Empty>
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
          Connect an environment that runs workflows to edit its library.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
