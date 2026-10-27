import { createFileRoute, redirect } from "@tanstack/react-router";

// Roles moved to the Library destination; old links land there.
export const Route = createFileRoute("/_chat/settings/roles")({
  beforeLoad: () => {
    throw redirect({ to: "/library", search: {}, replace: true });
  },
});
