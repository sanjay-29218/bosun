import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { rolesEnvironment } from "../../state/roles";
import { useEnvironmentQuery } from "../../state/query";

export function MobileCrewRunStatusStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const snapshot = useEnvironmentQuery(
    rolesEnvironment.snapshot({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const run = snapshot.data?.runs.find((item) => item.threadId === props.threadId);
  if (!run) return null;
  const owner =
    snapshot.data?.members.find((item) => item.id === run.memberId)?.name ?? run.memberId;
  const requests = snapshot.data?.handoffs.filter((item) => item.sourceRunId === run.id) ?? [];
  const waiting = requests.filter((item) => item.status === "needs-input").length;
  const active = requests.filter(
    (item) => item.status === "queued" || item.status === "running",
  ).length;
  const detail = [
    run.dispatchState === "queued" ? "queued" : run.turnState,
    active > 0 ? `${active} active` : null,
    waiting > 0 ? `${waiting} waiting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-4 py-2">
      <Text className="text-xs font-medium text-foreground">{owner}</Text>
      <Text className="text-xs text-muted-foreground">{detail}</Text>
    </View>
  );
}
