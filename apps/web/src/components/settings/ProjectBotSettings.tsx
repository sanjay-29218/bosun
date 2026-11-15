import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentId, ProjectId, ProjectRemoteBot } from "@t3tools/contracts";

import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { BotOwnerSelect } from "../bots/BotProjects";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Project settings: the bot that owns each of the project's checkouts. */
export function ProjectBotSection({
  members,
}: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly botId?: string | null | undefined;
    readonly remoteBot?: ProjectRemoteBot | null | undefined;
    readonly environmentLabel: string | null;
  }>;
}) {
  if (members.length === 0) return null;
  return (
    <SettingsSection title="Bot" id={searchableSetting("project-bot").id}>
      {members.map((member) => (
        <ProjectBotRow
          key={`${member.environmentId}:${member.id}`}
          member={member}
          showEnvironment={members.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectBotRow({
  member,
  showEnvironment,
}: {
  readonly member: Parameters<typeof ProjectBotSection>[0]["members"][number];
  readonly showEnvironment: boolean;
}) {
  const bots = useEnvironmentQuery(
    botsEnvironment.list({ environmentId: member.environmentId, input: {} }),
  );
  return (
    <SettingsRow
      title={showEnvironment ? (member.environmentLabel ?? "Environment") : "Owner"}
      description={
        bots.error ??
        (member.remoteBot != null
          ? `${member.remoteBot.name} lives on ${member.remoteBot.homeLabel} and starts this project's work over the link. With no bot, its project manager still runs it.`
          : "The bot that runs this project's work. With no bot, its project manager still runs it.")
      }
      control={
        <BotOwnerSelect
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          botId={projectBotId(member)}
          remoteBot={member.remoteBot ?? null}
          bots={bots.data ?? []}
          loading={!bots.data && !bots.error}
        />
      }
    />
  );
}
