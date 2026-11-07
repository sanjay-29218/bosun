import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";
import { validateBotsSearch } from "../components/bots/botsSearch";

function BotsSettingsRoute() {
  const search = Route.useSearch();
  return (
    <BotsPage
      {...(search.environmentId ? { environmentId: search.environmentId } : {})}
      {...(search.botId ? { botId: search.botId } : {})}
      {...(search.new ? { new: true } : {})}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/bots")({
  validateSearch: validateBotsSearch,
  component: BotsSettingsRoute,
});
