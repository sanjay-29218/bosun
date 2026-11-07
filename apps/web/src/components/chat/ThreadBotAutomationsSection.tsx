import { headquartersBotId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";

import { useEnvironmentScheduledTasks } from "../../state/automations";
import { scheduleLabel } from "../automations/ScheduledTaskEditor";
import { AUTOMATIONS_PATH } from "../sidebar/mainAppLocation";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** On a bot's headquarters, the automations that bot runs; each opens in Automations. */
export function ThreadBotAutomationsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const botId = headquartersBotId(props.threadId);
  const tasks = useEnvironmentScheduledTasks(props.environmentId);
  const navigate = useNavigate();
  const owned = botId === null ? [] : (tasks ?? []).filter((task) => task.botId === botId);
  if (owned.length === 0) return null;
  return (
    <ThreadDetailsSection headingId="thread-details-bot-automations-heading" title="Automations">
      <div className="flex flex-col">
        {owned.map((task) => (
          <ThreadDetailsControl
            key={task.id}
            part="row"
            aria-label={`Open ${task.title} in Automations`}
            onClick={() =>
              void navigate({
                to: AUTOMATIONS_PATH,
                search: { environmentId: props.environmentId, taskId: task.id },
              })
            }
          >
            <CalendarClockIcon className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-start">{task.title}</span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {task.enabled ? scheduleLabel(task.schedule) : "Paused"}
            </span>
          </ThreadDetailsControl>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
