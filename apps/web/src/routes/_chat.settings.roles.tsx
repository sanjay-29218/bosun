import { createFileRoute } from "@tanstack/react-router";

import { RolesSettings } from "../components/settings/RolesSettings";

export const Route = createFileRoute("/_chat/settings/roles")({
  component: RolesSettings,
});
