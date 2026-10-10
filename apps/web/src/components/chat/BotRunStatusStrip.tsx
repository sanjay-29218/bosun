import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";

export function BotRunStatusStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const snapshot = useEnvironmentQuery(
    botsEnvironment.snapshot({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const run = snapshot.data?.runs.find((item) => item.threadId === props.threadId);
  if (!run) return null;
  const owner = snapshot.data?.definitions.find((item) => item.id === run.botId)?.name ?? run.botId;
  const requests = snapshot.data?.handoffs.filter((item) => item.sourceRunId === run.id) ?? [];
  const waiting = requests.filter((item) => item.status === "needs-input").length;
  const active = requests.filter(
    (item) => item.status === "queued" || item.status === "running",
  ).length;
  return (
    <div
      className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground"
      role="status"
    >
      <span className="font-medium text-foreground">{owner}</span>
      <span>·</span>
      <span>{run.dispatchState === "queued" ? "queued" : run.turnState}</span>
      {active > 0 ? (
        <span>
          · {active} active request{active === 1 ? "" : "s"}
        </span>
      ) : null}
      {waiting > 0 ? (
        <span>
          · {waiting} question{waiting === 1 ? "" : "s"} waiting
        </span>
      ) : null}
    </div>
  );
}
