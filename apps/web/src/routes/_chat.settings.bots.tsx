import { createFileRoute } from "@tanstack/react-router";

import { BotsSettings } from "../components/settings/BotsSettings";

export const Route = createFileRoute("/_chat/settings/bots")({
  component: BotsSettings,
});
