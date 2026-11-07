import { createFileRoute } from "@tanstack/react-router";

import { LibraryPage } from "../components/library/LibraryPage";
import { validateLibrarySearch } from "../components/library/librarySearch";

function SettingsWorkflowsRoute() {
  const { environmentId, workflowId, roleId, new: creating } = Route.useSearch();
  return (
    <LibraryPage
      kind="workflow"
      search={{
        ...(environmentId ? { environmentId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(roleId ? { roleId } : {}),
        ...(creating ? { new: creating } : {}),
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/workflows")({
  validateSearch: validateLibrarySearch,
  component: SettingsWorkflowsRoute,
});
