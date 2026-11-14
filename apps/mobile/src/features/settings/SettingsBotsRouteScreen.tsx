import { useAtomValue } from "@effect/atom-react";
import {
  createLogicalBotResolver,
  isManagerPinned,
  projectBotId,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import { projectManagerLook } from "@t3tools/client-runtime/project-manager-look";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BotAvatar } from "../../components/BotAvatar";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { botsEnvironment, useActiveBot } from "../../state/bots";
import { environmentProjects } from "../../state/projects";
import { rolesEnvironment } from "../../state/roles";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Every bot, then every project manager, each with a pin that keeps it in the thread list's
 * switcher. A row opens its thread; an unpinned bot picked here stays the active one.
 */
export function SettingsBotsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const activeBot = useActiveBot();
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const setPin = useAtomCommand(botsEnvironment.setPin, { reportFailure: false });
  const openHeadquarters = useAtomCommand(botsEnvironment.openHeadquarters, {
    reportFailure: false,
  });
  const openManager = useAtomCommand(rolesEnvironment.openProjectManager, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [botsError, setBotsError] = useState<string | null>(null);
  const [managersError, setManagersError] = useState<string | null>(null);

  const ownerOf = createLogicalBotResolver(activeBot.bots);
  const botNames = new Map(activeBot.bots.map((bot) => [bot.key, bot.name]));
  const managers = projects
    .filter(
      (project) =>
        !project.isScratch &&
        !project.isBotHome &&
        configs.get(project.environmentId)?.environment.capabilities.workflows === true,
    )
    .sort((left, right) => left.title.localeCompare(right.title));

  const pushThread = (environmentId: EnvironmentId, threadId: string) =>
    navigation.dispatch(
      StackActions.push("Thread", { environmentId: String(environmentId), threadId }),
    );
  const toggle = async (
    key: string,
    pinned: boolean,
    targets: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly input: { readonly botId: string } | { readonly projectId: ProjectId };
    }>,
    onError: (message: string | null) => void,
  ) => {
    onError(null);
    setPending((current) => new Map(current).set(key, pinned));
    const results = await Promise.all(
      targets.map((target) =>
        setPin({ environmentId: target.environmentId, input: { ...target.input, pinned } }),
      ),
    );
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    const failure = results.find((result) => result._tag === "Failure");
    if (failure?._tag === "Failure") onError(Cause.pretty(failure.cause));
  };
  const openBot = async (bot: LogicalBot) => {
    const member = bot.members[0];
    if (!member) return;
    // Picking a bot here makes it the active one, pinned or not.
    activeBot.select(bot);
    const result = await openHeadquarters({
      environmentId: member.environmentId,
      input: { botId: member.botId },
    });
    if (result._tag === "Success") pushThread(member.environmentId, result.value.threadId);
    else Alert.alert(`Could not open ${bot.name}`, Cause.pretty(result.cause));
  };

  return (
    <SettingsScreen title="Bots">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {activeBot.bots.length === 0 ? (
          <Text className="text-foreground-muted">
            No bots yet. Add one in Bosun on your computer.
          </Text>
        ) : (
          <SettingsSection title="Bots">
            {activeBot.bots.map((bot) => {
              const pinned = pending.get(bot.key) ?? bot.pinned;
              const count = projects.filter(
                (project) =>
                  !project.isScratch &&
                  !project.isBotHome &&
                  ownerOf(project.environmentId, projectBotId(project)) === bot.key,
              ).length;
              return (
                <BotsRow
                  key={bot.key}
                  name={bot.name}
                  subtitle={
                    count === 0 ? "No projects" : `${count} project${count === 1 ? "" : "s"}`
                  }
                  avatar={<BotAvatar avatar={bot.avatar} color={bot.color} size={32} />}
                  pinned={pinned}
                  onOpen={() => void openBot(bot)}
                  onTogglePin={() =>
                    void toggle(
                      bot.key,
                      !pinned,
                      bot.members.map((member) => ({
                        environmentId: member.environmentId,
                        input: { botId: member.botId },
                      })),
                      setBotsError,
                    )
                  }
                />
              );
            })}
            {botsError ? <Text className="px-4 py-2 text-sm text-red-500">{botsError}</Text> : null}
          </SettingsSection>
        )}
        {managers.length === 0 ? null : (
          <SettingsSection title="Project managers">
            {managers.map((project) => {
              const key = `${project.environmentId}:${project.id}`;
              const pinned = pending.get(key) ?? isManagerPinned(project);
              const owner = ownerOf(project.environmentId, projectBotId(project));
              const look = projectManagerLook(project.id, null);
              return (
                <BotsRow
                  key={key}
                  name={project.title}
                  subtitle={owner === null ? "No bot" : (botNames.get(owner) ?? "No bot")}
                  avatar={<BotAvatar avatar={look.avatar} color={look.color} size={32} />}
                  pinned={pinned}
                  onOpen={async () => {
                    const result = await openManager({
                      environmentId: project.environmentId,
                      input: { projectId: project.id },
                    });
                    if (result._tag === "Success") {
                      pushThread(project.environmentId, result.value.threadId);
                    } else {
                      Alert.alert(
                        `Could not open ${project.title}'s project manager`,
                        Cause.pretty(result.cause),
                      );
                    }
                  }}
                  onTogglePin={() =>
                    void toggle(
                      key,
                      !pinned,
                      [{ environmentId: project.environmentId, input: { projectId: project.id } }],
                      setManagersError,
                    )
                  }
                />
              );
            })}
            {managersError ? (
              <Text className="px-4 py-2 text-sm text-red-500">{managersError}</Text>
            ) : null}
          </SettingsSection>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function BotsRow(props: {
  readonly name: string;
  readonly subtitle: string;
  readonly avatar: React.ReactNode;
  readonly pinned: boolean;
  readonly onOpen: () => void;
  readonly onTogglePin: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3 py-2 pr-1 pl-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${props.name}`}
        className="min-w-0 flex-1 flex-row items-center gap-3"
        onPress={props.onOpen}
      >
        {props.avatar}
        <View className="min-w-0 flex-1">
          <Text className="text-base text-foreground" numberOfLines={1}>
            {props.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: props.pinned }}
        accessibilityLabel={props.pinned ? `Unpin ${props.name}` : `Pin ${props.name}`}
        className="size-11 items-center justify-center"
        onPress={props.onTogglePin}
      >
        <SymbolView
          name={props.pinned ? "pin.fill" : "pin"}
          size={18}
          tintColorClassName={props.pinned ? "accent-icon" : "accent-icon-muted"}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
