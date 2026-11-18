import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LibraryCopy, LibraryOwner } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { offersLinkedEnvironmentsAtom, peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

/** What a linked machine has of it: copied, behind, or kept back there and why. */
const copyNote = (copy: LibraryCopy | undefined, revision: number, nowMs: number) => {
  if (copy?.problem != null) return copy.problem;
  if (copy?.deliveredAt == null) return "Not there yet. It gets a copy when it answers.";
  const when = formatRelativeTimeLabel(copy.deliveredAt, nowMs);
  return copy.deliveredRevision === revision
    ? `Copied ${when}`
    : `Has an older copy from ${when}. Gets this one when it answers.`;
};

/**
 * Every machine this one links to gets a copy of each workflow and role made here; this lists
 * them, read-only. Linking and unlinking machines is the only control.
 */
export function LibraryMachines({
  environmentId,
  item,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: { readonly revision: number; readonly copies: ReadonlyArray<LibraryCopy> };
}) {
  const offered = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const links = useEnvironmentQuery(
    offered ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const nowMinute = useNowMinute();
  const list = links.data?.links ?? [];
  if (list.length === 0) return null;
  return (
    <SettingsSection title="Copies on linked machines">
      <ul className="divide-y divide-border">
        {list.map((link) => (
          <li key={link.environmentId} className="flex min-w-0 flex-col px-3 py-2.5 sm:px-4">
            <span className="truncate text-sm font-medium">{link.label}</span>
            <span className="truncate text-xs text-muted-foreground">
              {copyNote(
                item.copies.find((copy) => copy.environmentId === link.environmentId),
                item.revision,
                Date.parse(nowMinute),
              )}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

/** A copy is edited on the machine it came from. */
export function ManagedFromNotice({
  noun,
  owner,
}: {
  readonly noun: "workflow" | "role";
  readonly owner: LibraryOwner;
}) {
  return (
    <Alert variant="info">
      <AlertTitle>Managed from {owner.label}</AlertTitle>
      <AlertDescription>
        This {noun} is a copy. Edit it on {owner.label}, and the change reaches this machine.
      </AlertDescription>
    </Alert>
  );
}
