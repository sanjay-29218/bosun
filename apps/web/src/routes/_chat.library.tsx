import { createFileRoute } from "@tanstack/react-router";

import { LibraryPage } from "../components/library/LibraryPage";
import { validateLibrarySearch } from "../components/library/librarySearch";

function LibraryRouteView() {
  const search = Route.useSearch();
  return <LibraryPage {...search} />;
}

export const Route = createFileRoute("/_chat/library")({
  validateSearch: validateLibrarySearch,
  component: LibraryRouteView,
});
