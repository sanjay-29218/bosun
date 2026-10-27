import { useNavigation } from "@react-navigation/native";
import { humanizeCrewId } from "@t3tools/client-runtime/state/crew";
import type { EnvironmentId, ProjectId, ThreadId, WorkflowStageHandoff } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import { fileRoutePathSegments } from "../files/filePath";

function summaryLine(handoff: WorkflowStageHandoff): string {
  return [
    ...handoff.outputs.map((output) =>
      output.kind === "file"
        ? `${output.path} v${output.version}`
        : `${humanizeCrewId(output.stepId)} diff`,
    ),
    ...(handoff.notes.some((note) => note.kind === "decision") ? ["your note"] : []),
    ...(handoff.workspace.branch ? [handoff.workspace.branch] : []),
  ].join(" · ");
}

/**
 * Pinned at the top of a stage thread: what the stage started from. Collapsed it is one
 * line; expanded it lists the outputs (files open in the file viewer), notes and workspace.
 */
export const CrewHandoffCard = memo(function CrewHandoffCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const { data: handoff } = useEnvironmentQuery(
    workflowsEnvironment.stageHandoff({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, threadId: props.threadId },
    }),
  );
  if (!handoff) return null;
  const title = handoff.from
    ? `Handoff from ${humanizeCrewId(handoff.from.stepId)}`
    : `Brief · ${handoff.workflow.name}`;
  const line = summaryLine(handoff);
  return (
    <View className="mb-3 rounded-2xl border border-border bg-card-alt">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}
        onPress={() => setExpanded((value) => !value)}
        className="gap-0.5 px-4 py-3 active:opacity-70"
      >
        <Text className="font-t3-bold text-sm text-foreground">{title}</Text>
        {line ? (
          <Text className="text-xs text-foreground-secondary" numberOfLines={expanded ? 0 : 1}>
            {line}
          </Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View className="gap-3 border-t border-border px-4 py-3">
          {handoff.retry ? (
            <Text className="text-xs text-danger-foreground">
              Retrying after: {handoff.retry.previousError}
            </Text>
          ) : null}
          {handoff.outputs.length > 0 ? (
            <View className="gap-1.5">
              <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
                Outputs
              </Text>
              {handoff.outputs.map((output) =>
                output.kind === "file" ? (
                  <Pressable
                    key={`${output.stepId}:${output.path}`}
                    accessibilityRole="link"
                    disabled={output.exists === false}
                    onPress={() =>
                      navigation.navigate("ThreadFile", {
                        environmentId: String(props.environmentId),
                        threadId: String(props.threadId),
                        path: fileRoutePathSegments(output.path),
                      })
                    }
                    className="active:opacity-70 disabled:opacity-50"
                  >
                    <Text className="text-sm text-foreground">
                      {output.path} v{output.version}
                      <Text className="text-xs text-foreground-secondary">
                        {"  ·  "}
                        {humanizeCrewId(output.stepId)}
                        {output.exists === false ? " · missing" : ""}
                      </Text>
                    </Text>
                  </Pressable>
                ) : (
                  <Text key={`${output.stepId}:diff`} className="text-sm text-foreground">
                    {humanizeCrewId(output.stepId)} diff
                    <Text className="text-xs text-foreground-secondary">
                      {"  ·  "}+{output.additions} −{output.deletions} · {output.fileCount} files
                    </Text>
                  </Text>
                ),
              )}
            </View>
          ) : null}
          {handoff.notes.map((note) => (
            <View key={`${note.stepId}:${note.occurredAt}`} className="gap-0.5">
              <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
                {note.kind === "decision" ? "Your note" : `From ${humanizeCrewId(note.stepId)}`}
              </Text>
              <Text className="text-sm text-foreground">{note.text}</Text>
            </View>
          ))}
          <View className="gap-0.5">
            <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
              Task
            </Text>
            <Text className="text-sm text-foreground">{handoff.task}</Text>
            {handoff.scope ? (
              <Text className="text-xs text-foreground-secondary">Scope: {handoff.scope}</Text>
            ) : null}
          </View>
          {handoff.workspace.branch ? (
            <Text className="text-xs text-foreground-secondary">
              {handoff.workspace.branch}
              {handoff.workspace.commit ? ` @ ${handoff.workspace.commit.slice(0, 7)}` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});
