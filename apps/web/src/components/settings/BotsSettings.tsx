import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { botsEnvironment } from "../../state/bots";
import { useEnvironmentQuery } from "../../state/query";
import { BotOwnerSelect } from "../bots/BotProjects";
import { BOTS_PATH } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { CrewLimitsSettings } from "./CrewLimitsSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** What applies to every bot. The bots themselves are added and edited in the rail's Bots. */
export function BotsSettings() {
  const navigate = useNavigate();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Bots" id={searchableSetting("bots").id}>
        <SettingsRow
          title="Your bots"
          description="Add, edit and reorder bots, and move projects between them, from Bots in the rail."
          control={
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: BOTS_PATH })}>
              Open Bots
              <ArrowRightIcon />
            </Button>
          }
        />
      </SettingsSection>
      <CrewLimitsSettings />
    </SettingsPageContainer>
  );
}

/** Project settings: the bot that owns each of the project's checkouts. */
export function ProjectBotSection({
  members,
}: {
  readonly members: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly botId?: string | undefined;
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
        bots.error ?? "The bot that runs this project's work. Its threads show under that bot."
      }
      control={
        <BotOwnerSelect
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          botId={projectBotId(member)}
          bots={bots.data ?? []}
        />
      }
    />
  );
}
