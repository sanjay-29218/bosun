import { createFileRoute, redirect } from "@tanstack/react-router";

// Workflows moved to the Library destination; old links land there.
export const Route = createFileRoute("/_chat/settings/workflows")({
  beforeLoad: () => {
    throw redirect({ to: "/library", search: {}, replace: true });
  },
});
