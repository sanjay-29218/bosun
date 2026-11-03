import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildCrewRoster, type CrewRosterEntry } from "@t3tools/client-runtime/state/crew-roster";
import { workGroupLead } from "@t3tools/client-runtime/state/work-groups";
import { featureIssueRef, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { buildThreadRouteParams } from "../../threadRoutes";
import { CrewRosterHereMark, CrewRosterIcon, CrewRosterStatus } from "./CrewRosterIcon";
import { FeatureTag } from "./FeatureTag";

function SectionTitle({ children }: { readonly children: string }) {
  return <h3 className="px-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/**
 * The Crew tab: everyone working on a feature or bot request, and for a feature its workspace.
 * Opens from any of its threads.
 */
export function CrewPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(props.threadRef);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? props.threadRef : null);
  const navigate = useNavigate();
  if (!thread || !group) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This thread isn't part of a feature or a bot request.
      </p>
    );
  }
  const roster = buildCrewRoster(group);
  // The lead's thread holds the feature's branch and pull request; its crew works in the same.
  const lead = group.kind === "feature" ? workGroupLead(group) : null;
  const pullRequest = lead ? (lead.linkedPullRequest ?? lead.branchPullRequest ?? null) : null;
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-3 text-sm">
        <header className="flex min-w-0 items-center gap-2 px-1">
          {thread.feature ? (
            <FeatureTag feature={thread.feature} />
          ) : (
            <span className="min-w-0 truncate font-medium">{group.title}</span>
          )}
          {thread.feature?.issue ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {featureIssueRef(thread.feature.issue)}
            </span>
          ) : null}
        </header>

        <section className="flex flex-col gap-1">
          <SectionTitle>Crew</SectionTitle>
          <ol className="flex flex-col">
            {roster.map((entry) => (
              <CrewPanelEntry
                key={entry.key}
                entry={entry}
                here={entry.threadId === thread.id}
                onOpenThread={openThread}
              />
            ))}
          </ol>
        </section>

        {lead ? (
          <section className="flex flex-col gap-1">
            <SectionTitle>Workspace</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 text-xs">
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="truncate font-mono">{lead.branch ?? "None yet"}</dd>
              <dt className="text-muted-foreground">Pull request</dt>
              <dd className="truncate">{pullRequest ? `#${pullRequest.number}` : "None yet"}</dd>
            </dl>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function CrewPanelEntry(props: {
  readonly entry: CrewRosterEntry;
  readonly here: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { entry } = props;
  return (
    <li className="relative rounded-md">
      {props.here ? <CrewRosterHereMark /> : null}
      <button
        type="button"
        aria-current={props.here ? "page" : undefined}
        onClick={() => props.onOpenThread(entry.threadId)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
      >
        <CrewRosterIcon tone={entry.tone} />
        <span className="min-w-0 flex-1 truncate">
          {entry.name}
          {entry.kind === "lead" ? <span className="text-muted-foreground"> · lead</span> : null}
        </span>
        <CrewRosterStatus entry={entry} />
      </button>
    </li>
  );
}
