import type { Bot, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { LinkedMachineChecklist } from "../settings/LinkedMachineChecklist";

/**
 * The linked machines a bot may start work on, ticked on its home. A tick saves at once; ids no
 * longer linked stay saved untouched and aren't shown.
 */
export function BotPermittedEnvironments({
  environmentId,
  homeLabel,
  bot,
  canEdit,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly bot: Bot;
  readonly canEdit: boolean;
  readonly onSave: (permittedEnvironmentIds: ReadonlyArray<EnvironmentId>) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);

  const toggle = async (linkedId: EnvironmentId, permitted: boolean) => {
    setSaving(true);
    await onSave(
      permitted
        ? [...bot.permittedEnvironmentIds, linkedId]
        : bot.permittedEnvironmentIds.filter((id) => id !== linkedId),
    );
    setSaving(false);
  };

  return (
    <LinkedMachineChecklist
      environmentId={environmentId}
      homeLabel={homeLabel}
      description={`${homeLabel}'s linked machines this bot may start work on.`}
      emptyDescription={`Link another machine running Bosun, such as a VPS, so ${bot.name} can work there.`}
      checked={bot.permittedEnvironmentIds}
      disabled={saving || !canEdit}
      onToggle={(linkedId, permitted) => void toggle(linkedId, permitted)}
    />
  );
}
