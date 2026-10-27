import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { BotAvatar } from "../../components/BotAvatar";
import { Menu } from "../../components/ui/Menu";
import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/** The bot that owns the project, and moving it to another bot (or back). */
export function MobileProjectBotSection(props: {
  readonly project: EnvironmentProject;
  readonly environmentLabel: string;
}) {
  const { project } = props;
  const bots = useEnvironmentQuery(
    botsEnvironment.list({ environmentId: project.environmentId, input: {} }),
  );
  const moveProject = useAtomCommand(botsEnvironment.moveProject);
  const [error, setError] = useState<string | null>(null);
  const ownerId = projectBotId(project);
  const list = bots.data ?? [];
  const owner = list.find((bot) => bot.id === ownerId);

  const move = async (botId: string) => {
    if (botId === ownerId) return;
    setError(null);
    const result = await moveProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, botId },
    });
    if (result._tag !== "Success") setError(Cause.pretty(result.cause));
  };

  return (
    <SettingsSection title={`Bot · ${props.environmentLabel}`}>
      <View className="gap-3 p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-t3-medium text-foreground-muted">Owned by</Text>
          <Menu
            accessibilityLabel="Move to another bot"
            title="Move to bot"
            actions={list.map((bot) => ({
              id: bot.id,
              title: bot.name,
              state: bot.id === ownerId ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => void move(nativeEvent.event)}
          >
            <View className="flex-row items-center gap-2 rounded-full bg-subtle-strong py-1.5 pr-3.5 pl-1.5">
              {owner ? <BotAvatar avatar={owner.avatar} color={owner.color} size={24} /> : null}
              <Text className="text-sm font-t3-medium text-foreground">
                {owner?.name ?? "Captain"} ▾
              </Text>
            </View>
          </Menu>
        </View>
        {bots.error ? <Text className="text-sm text-red-500">{bots.error}</Text> : null}
        {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      </View>
    </SettingsSection>
  );
}
