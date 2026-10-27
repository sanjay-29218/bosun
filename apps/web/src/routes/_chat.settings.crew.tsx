import { createFileRoute, redirect } from "@tanstack/react-router";

// Crew settings became Roles, which moved to the Library; keep old links working.
export const Route = createFileRoute("/_chat/settings/crew")({
  beforeLoad: () => {
    throw redirect({ to: "/library", search: {}, replace: true });
  },
});
