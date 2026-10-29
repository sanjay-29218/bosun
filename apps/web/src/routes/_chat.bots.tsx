import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";
import { validateBotsSearch } from "../components/bots/botsSearch";

function BotsRouteView() {
  const search = Route.useSearch();
  return <BotsPage {...search} />;
}

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: validateBotsSearch,
  component: BotsRouteView,
});
