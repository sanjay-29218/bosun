import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateAutomationsSearch } from "../components/automations/scheduledTaskEditor.logic";

// Scheduled tasks moved to the Automations destination; old links land there.
export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateAutomationsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/automations",
      search: {
        ...(search.environmentId === undefined ? {} : { environmentId: search.environmentId }),
        ...(search.taskId === undefined ? {} : { taskId: search.taskId }),
      },
      replace: true,
    });
  },
});
