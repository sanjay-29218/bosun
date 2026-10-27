import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";
import { validateAutomationsSearch } from "../components/automations/scheduledTaskEditor.logic";

function AutomationsRouteView() {
  const search = Route.useSearch();
  return <AutomationsPage {...search} />;
}

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: validateAutomationsSearch,
  component: AutomationsRouteView,
});
