import { createFileRoute, redirect } from "@tanstack/react-router";

// Crew settings became Roles; keep old links working.
export const Route = createFileRoute("/settings/crew")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/roles", search, replace: true });
  },
});
