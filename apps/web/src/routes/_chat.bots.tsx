import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateBotsSearch } from "../components/bots/botsSearch";

// Bots moved to Settings → Bots; old links and agent messages land there.
export const Route = createFileRoute("/_chat/bots")({
  validateSearch: validateBotsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/bots", search, replace: true });
  },
});
