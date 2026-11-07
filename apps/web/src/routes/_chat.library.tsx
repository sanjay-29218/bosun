import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateLibrarySearch } from "../components/library/librarySearch";

// The Library moved to Settings → Workflows and Roles; old links land on the matching page.
export const Route = createFileRoute("/_chat/library")({
  validateSearch: validateLibrarySearch,
  beforeLoad: ({ search }) => {
    const roles = search.roleId !== undefined || search.new === "role";
    throw redirect({
      to: roles ? "/settings/roles" : "/settings/workflows",
      search,
      replace: true,
    });
  },
});
