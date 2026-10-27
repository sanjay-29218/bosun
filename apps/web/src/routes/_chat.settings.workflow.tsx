import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateLibrarySearch } from "../components/library/librarySearch";

// The workflow editor moved to the Library destination; old links open the same workflow there.
export const Route = createFileRoute("/_chat/settings/workflow")({
  validateSearch: (raw: Record<string, unknown>) =>
    validateLibrarySearch({ environmentId: raw.environment, workflowId: raw.workflow }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/library",
      search:
        search.environmentId === undefined || search.workflowId === undefined
          ? {}
          : { environmentId: search.environmentId, workflowId: search.workflowId },
      replace: true,
    });
  },
});
