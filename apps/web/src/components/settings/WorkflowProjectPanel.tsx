import { useState } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { BotsProjectSection } from "./BotsProjectSection";
import { FeaturesProjectSection } from "./FeaturesProjectSection";
import { WorkflowsProjectSection } from "./WorkflowsProjectSection";
import { SettingsPageContainer } from "./settingsLayout";

export function WorkflowProjectPanel({ group }: { group: SidebarProjectSnapshot }) {
  const { environments } = useEnvironments();
  const [featureSelections, setFeatureSelections] = useState<Record<string, string>>({});
  return (
    <SettingsPageContainer className="gap-6">
      {group.memberProjects.map((member) => {
        const key = `${member.environmentId}:${member.id}`;
        const capabilities = environments.find(
          (entry) => entry.environmentId === member.environmentId,
        )?.serverConfig?.environment.capabilities;
        return (
          <div key={key} className="grid min-w-0 grid-cols-1 gap-6">
            {capabilities?.features === true ? (
              <FeaturesProjectSection
                project={member}
                onSelect={(id) => setFeatureSelections((current) => ({ ...current, [key]: id }))}
              />
            ) : null}
            {capabilities?.bots === true ? <BotsProjectSection project={member} /> : null}
            {capabilities?.workflows === true ? (
              <WorkflowsProjectSection project={member} featureId={featureSelections[key]} />
            ) : null}
            {!capabilities?.features && !capabilities?.bots && !capabilities?.workflows ? (
              <p className="text-sm text-muted-foreground">
                {member.environmentLabel ?? "This environment"} does not currently support
                workflows. Connect or update its server to continue.
              </p>
            ) : null}
          </div>
        );
      })}
    </SettingsPageContainer>
  );
}
