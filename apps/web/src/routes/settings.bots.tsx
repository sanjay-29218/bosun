import { createFileRoute } from "@tanstack/react-router";

import { BotsSettings } from "../components/settings/BotsSettings";

export const Route = createFileRoute("/settings/bots")({
  component: BotsSettings,
});
