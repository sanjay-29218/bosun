import { useAtomValue } from "@effect/atom-react";
import { automationPausedLabel } from "@t3tools/client-runtime/state/automations";
import {
  headquartersBotId,
  headquartersProjectId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PlusIcon } from "lucide-react";

import { useEnvironmentScheduledTasks } from "../../state/automations";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { scheduleLabel } from "../automations/scheduledTaskEditor.logic";
import { AUTOMATIONS_PATH } from "../sidebar/mainAppLocation";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useClientSettings } from "../../hooks/useSettings";

/**
 * On a bot's headquarters or a project manager's thread, the automations that run as it; each
 * opens in Automations. A manager's also offers a new one that runs as it.
 */
export function ThreadBotAutomationsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const botId = headquartersBotId(props.threadId);
  const managerProjectId = headquartersProjectId(props.threadId);
  const tasks = useEnvironmentScheduledTasks(props.environmentId);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  const environment = useEnvironment(props.environmentId);
  const canSave = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const canAdd =
    managerProjectId !== null &&
    canSave &&
    environment?.serverConfig?.environment.capabilities.scheduledTaskProjectManagers === true;
  const owned = (tasks ?? []).filter((task) =>
    botId !== null
      ? task.botId === botId
      : managerProjectId !== null && task.projectManager === true
        ? task.projectId === managerProjectId
        : false,
  );
  if (owned.length === 0 && !canAdd) return null;
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
              {task.enabled
                ? scheduleLabel(task.schedule, timestampFormat)
                : (automationPausedLabel(task) ?? "Paused")}
            </span>
          </ThreadDetailsControl>
        ))}
        {!canAdd || managerProjectId === null ? null : (
          <ThreadDetailsControl
            part="row"
            tone="muted"
            onClick={() =>
              void navigate({
                to: AUTOMATIONS_PATH,
                search: {
                  environmentId: props.environmentId,
                  new: true,
                  managerProjectId,
                },
              })
            }
          >
            <PlusIcon />
            <span className="min-w-0 flex-1 truncate text-start">Add automation</span>
          </ThreadDetailsControl>
        )}
      </div>
    </ThreadDetailsSection>
  );
}
