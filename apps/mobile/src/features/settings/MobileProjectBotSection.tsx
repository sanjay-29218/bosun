import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { BotAvatar } from "../../components/BotAvatar";
import { Menu } from "../../components/ui/Menu";
import { botsEnvironment, useLogicalBots } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

// The menu's "No bot" action and the owner from another machine; bot ids never take these forms.
const NO_BOT = "";
const REMOTE_OWNER = "remote:";

/** The bot that owns the project, and moving it to another bot or to none. */
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
  const remote = project.remoteBot ?? null;
  const list = bots.data ?? [];
  const owner = list.find((bot) => bot.id === ownerId);
  // A remote owner's look, when this client has its home machine's bots.
  const remoteLook = useLogicalBots().find(
    (bot) =>
      remote !== null &&
      bot.members[0]!.environmentId === remote.environmentId &&
      bot.members[0]!.botId === remote.botId,
  );

  const move = async (action: string) => {
    if (action === REMOTE_OWNER) return;
    const botId = action === NO_BOT ? null : action;
    if (remote === null && botId === ownerId) return;
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
            title="Owner"
            actions={[
              ...list.map((bot) => ({
                id: bot.id,
                title: bot.name,
                state: bot.id === ownerId ? ("on" as const) : ("off" as const),
              })),
              ...(remote === null
                ? []
                : [
                    {
                      id: REMOTE_OWNER,
                      title: `${remote.name} · ${remote.homeLabel}`,
                      state: "on" as const,
                    },
                  ]),
              {
                id: NO_BOT,
                title: "No bot",
                state: ownerId === null && remote === null ? "on" : "off",
              },
            ]}
            onPressAction={({ nativeEvent }) => void move(nativeEvent.event)}
          >
            <View className="flex-row items-center gap-2 rounded-full bg-subtle-strong py-1.5 pr-3.5 pl-1.5">
              {remote !== null ? (
                remoteLook ? (
                  <BotAvatar avatar={remoteLook.avatar} color={remoteLook.color} size={24} />
                ) : null
              ) : owner ? (
                <BotAvatar avatar={owner.avatar} color={owner.color} size={24} />
              ) : null}
              <Text className="text-sm font-t3-medium text-foreground">
                {remote !== null
                  ? `${remote.name} · ${remote.homeLabel}`
                  : (owner?.name ?? (bots.data ? "No bot" : "Loading…"))}{" "}
                ▾
              </Text>
            </View>
          </Menu>
        </View>
        {remote !== null ? (
          <Text className="text-sm text-foreground-muted">
            Lives on {remote.homeLabel}. Starts work here over the link.
          </Text>
        ) : null}
        {bots.error ? <Text className="text-sm text-red-500">{bots.error}</Text> : null}
        {error ? <Text className="text-sm text-red-500">{error}</Text> : null}
      </View>
    </SettingsSection>
  );
}
