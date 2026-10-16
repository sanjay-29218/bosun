import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { botHeadquartersThreadId } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { BotAvatar } from "../../components/BotAvatar";

/**
 * The active bot at the top of the thread list, as on web. Tapping it opens the bot's
 * headquarters, which the list leaves out. A dot shows while that thread works or waits on you.
 */
export const BotHeaderRow = memo(function BotHeaderRow(props: {
  readonly bot: LogicalBot;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectCount: number;
  readonly onOpen: (bot: LogicalBot) => void;
}) {
  const { bot } = props;
  const headquarters = props.threads.find((thread) =>
    bot.members.some(
      (member) =>
        member.environmentId === thread.environmentId &&
        botHeadquartersThreadId(member.botId) === thread.id,
    ),
  );
  const waiting = headquarters !== undefined && threadNeedsYouKind(headquarters) !== null;
  const working = headquarters !== undefined && !waiting && isThreadWorking(headquarters);
  const status = waiting ? "needs you" : working ? "working" : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${bot.name}'s thread${status ? `, ${status}` : ""}`}
      onPress={() => props.onOpen(bot)}
      className="mx-4 mb-2 flex-row items-center gap-3 rounded-xl border border-border px-3 py-2.5 active:bg-subtle"
    >
      <BotAvatar avatar={bot.avatar} color={bot.color} size={30} />
      <View className="min-w-0 flex-1">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {bot.name}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.projectCount === 1 ? "1 project" : `${props.projectCount} projects`}
        </Text>
      </View>
      {waiting ? (
        <View className="size-2 rounded-full bg-warning" />
      ) : working ? (
        <View className="size-2 rounded-full bg-primary" />
      ) : null}
    </Pressable>
  );
});
