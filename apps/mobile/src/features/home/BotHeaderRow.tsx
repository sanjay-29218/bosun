import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { botHeadquartersThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { BotAvatar } from "../../components/BotAvatar";
import { botsEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The active bot at the top of the thread list, as on web. Tapping it opens the bot's
 * headquarters, which the list leaves out. A dot shows while that thread works or waits on you.
 * A long press starts that thread over in a new session.
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
  const startNewSession = useAtomCommand(botsEnvironment.startNewSession, { reportFailure: false });
  const member = bot.members.find(
    (candidate) => candidate.environmentId === headquarters?.environmentId,
  );
  const confirmNewSession = () => {
    if (!member) return;
    Dialog.confirm({
      title: `Start a new session for ${bot.name}?`,
      message:
        "You keep the whole conversation. The bot starts again from its instructions and the last few messages.",
      confirmText: "Start",
      onConfirm: () => {
        void startNewSession({
          environmentId: member.environmentId,
          input: { botId: member.botId },
        }).then((result) => {
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            Dialog.alert(
              "Could not start a new session",
              error instanceof Error ? error.message : "Try again when the bot finishes.",
            );
          }
        });
      },
    });
  };
  return (
    <Menu
      actions={[
        {
          id: "new-session",
          title: "Start new session",
          image: "arrow.clockwise",
          attributes: { disabled: !member || working || waiting },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "new-session") confirmNewSession();
      }}
      shouldOpenOnLongPress
    >
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
    </Menu>
  );
});
