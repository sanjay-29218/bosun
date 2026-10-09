import { createFileRoute } from "@tanstack/react-router";

import { CrewSettings } from "../components/settings/CrewSettings";

export const Route = createFileRoute("/settings/crew")({
  component: CrewSettings,
});
