import {
  CREW_STATE_LABELS,
  featureStageRows,
  featureTagColor,
  formatStageName,
} from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { featureIssueRef, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FileTextIcon,
  GitBranchIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { useWorkGroup } from "../../state/workGroup";
import { buildThreadRouteParams } from "../../threadRoutes";
import { WorkStageStrip } from "../sidebar/SidebarWorkGroup";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { CREW_ACTION_COPY } from "./crewActionCopy";
import { CREW_TONE_TEXT, CrewRosterIcon, CrewRosterStatus } from "./CrewRosterIcon";
import {
  buildCrewRoster,
  CREW_STATE_TONES,
  type CrewRosterEntry,
} from "@t3tools/client-runtime/state/crew-roster";
import { useCrewStageContext } from "./useCrewStage";

/** Every row shares one grid, so crew statuses, outputs' Open and workspace values line up. */
const ROW_CLASS = "flex h-8 min-w-0 items-center gap-2 rounded-md px-2";

function SectionTitle({ children }: { readonly children: string }) {
  return <h3 className="px-2 text-xs font-medium text-muted-foreground">{children}</h3>;
}

function WorkspaceRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string | null;
}) {
  const Icon = props.icon;
  return (
    <div className={ROW_CLASS}>
      <span aria-hidden className="size-4 shrink-0" />
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <dt className="min-w-0 flex-1 truncate text-muted-foreground">{props.label}</dt>
      <dd className={cn("min-w-0 truncate text-xs", !props.value && "text-muted-foreground")}>
        {props.value ?? "None yet"}
      </dd>
    </div>
  );
}

const WAITING_TITLES = {
  gate: "waits for your approval",
  failure: "failed",
  "your-call": "reached its limit; it's your call",
  "taken-over": "is yours to finish",
} as const;

/**
 * The Crew tab: everyone working on a feature or bot request, what waits on you, and for a
 * feature its outputs, workspace and controls. Opens from any of its threads.
 */
export function CrewPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onEditWorkflow: () => void;
}) {
  const stage = useCrewStageContext();
  const thread = useThreadShell(props.threadRef);
  const group = useWorkGroup(thread?.feature || thread?.crewRequest ? props.threadRef : null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [openStages, setOpenStages] = useState<ReadonlySet<string>>(new Set());
  if (!thread || !group) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This thread isn't part of a feature or a bot request.
      </p>
    );
  }
  const snapshot = stage?.thread.id === thread.id ? stage.snapshot : null;
  const roster = buildCrewRoster(group, snapshot);
  const current = group.kind === "feature" ? group.primary.crew : null;
  const state = snapshot?.state ?? current?.state ?? "working";
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, threadId)),
    });
  const run = async (
    action: Parameters<NonNullable<typeof stage>["run"]>[0],
    input?: Parameters<NonNullable<typeof stage>["run"]>[1],
  ) => {
    if (!stage) return;
    setBusy(true);
    await stage.run(action, input);
    setBusy(false);
  };
  const toggleStage = (key: string) =>
    setOpenStages((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const waiting = stage?.waiting ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-5 p-3 text-sm">
        <header className="flex flex-col gap-1.5 px-2">
          <h2 className="flex min-w-0 items-start gap-2 font-medium">
            {thread.feature ? (
              <span
                aria-hidden
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: featureTagColor(thread.feature.id) }}
              />
            ) : null}
            <span className="line-clamp-2 min-w-0 break-words">
              {thread.feature?.title ?? group.title}
            </span>
          </h2>
          {thread.feature?.issue || snapshot ? (
            <p className="truncate text-xs text-muted-foreground">
              {[
                thread.feature?.issue ? featureIssueRef(thread.feature.issue) : null,
                snapshot ? `${snapshot.definition.name} · v${snapshot.definition.revision}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {current && group.stageLine ? (
            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
              <WorkStageStrip stages={group.stages} />
              <span className="min-w-0 truncate text-muted-foreground">{group.stageLine}</span>
              <span className={cn("ms-auto shrink-0", CREW_TONE_TEXT[CREW_STATE_TONES[state]])}>
                {CREW_STATE_LABELS[state]}
              </span>
            </div>
          ) : null}
        </header>

        {waiting && snapshot ? (
          <section
            aria-label="Waiting on you"
            className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/8 p-3"
          >
            <span className="font-medium">
              {formatStageName(waiting.prompt.stepId)} {WAITING_TITLES[waiting.prompt.kind]}
            </span>
            {waiting.prompt.kind === "gate" && waiting.prompt.summary ? (
              <span className="line-clamp-3 text-xs text-muted-foreground">
                {waiting.prompt.summary}
              </span>
            ) : null}
            <span className="flex flex-wrap gap-2">
              {waiting.prompt.kind === "gate" && stage?.actions.includes("approve") ? (
                <Button size="xs" disabled={busy} onClick={() => void run("approve")}>
                  Approve
                </Button>
              ) : null}
              {waiting.threadId !== thread.id ? (
                <Button size="xs" variant="outline" onClick={() => openThread(waiting.threadId)}>
                  Open {formatStageName(waiting.prompt.stepId)}
                </Button>
              ) : null}
            </span>
          </section>
        ) : null}

        <section className="flex flex-col gap-1">
          <SectionTitle>Crew</SectionTitle>
          <ol className="flex flex-col gap-px">
            {roster.map((entry) => (
              <CrewPanelEntry
                key={entry.key}
                entry={entry}
                here={entry.threadId === thread.id}
                open={openStages.has(entry.key)}
                onToggle={() => toggleStage(entry.key)}
                onOpenThread={openThread}
              />
            ))}
          </ol>
        </section>

        {snapshot && stage ? (
          <CrewPanelFeatureDetails
            stage={stage}
            busy={busy}
            run={run}
            openThread={openThread}
            onEditWorkflow={props.onEditWorkflow}
          />
        ) : null}
      </div>
    </div>
  );
}

const ENTRY_DETAILS = {
  lead: "Leads the crew and answers its questions",
  helper: "Helps a stage with one task",
} as const;

function CrewPanelEntry(props: {
  readonly entry: CrewRosterEntry;
  readonly here: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { entry } = props;
  return (
    <li className={cn("rounded-md", entry.active && "bg-info/8 dark:bg-info/12")}>
      <div className={cn(ROW_CLASS, !entry.active && "hover:bg-accent/50")}>
        <button
          type="button"
          aria-expanded={props.open}
          aria-label={`${props.open ? "Hide" : "Show"} ${entry.name} details`}
          onClick={props.onToggle}
          className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          {props.open ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          disabled={entry.threadId === null}
          aria-current={props.here ? "page" : undefined}
          onClick={() => entry.threadId && props.onOpenThread(entry.threadId)}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-left disabled:cursor-default"
        >
          <CrewRosterIcon tone={entry.tone} />
          <span className="min-w-0 flex-1 truncate">
            <span className={cn(entry.active && "font-medium")}>{entry.name}</span>
            <span className="text-muted-foreground">
              {entry.kind === "lead" ? " · Lead" : entry.role ? ` · ${entry.role}` : ""}
            </span>
          </span>
          <CrewRosterStatus entry={entry} here={props.here} />
        </button>
      </div>
      {props.open ? (
        <div className="flex flex-col items-start gap-1 pt-0.5 pb-2 ps-12 pe-2 text-xs text-muted-foreground">
          <span>
            {entry.kind === "stage"
              ? `Run by ${entry.role ?? "its role"}${entry.gate ? " · waits for your approval when done" : ""}`
              : ENTRY_DETAILS[entry.kind]}
          </span>
          {entry.tries.map((threadId, index) => (
            <button
              key={threadId}
              type="button"
              className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => props.onOpenThread(threadId)}
            >
              Open try {index + 1}
            </button>
          ))}
          {entry.threadId ? (
            <button
              type="button"
              className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => props.onOpenThread(entry.threadId!)}
            >
              Open {entry.tries.length > 0 ? "the latest try" : "its thread"}
            </button>
          ) : (
            <span>Not started yet</span>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** A feature's outputs, workspace and controls, below its crew. */
function CrewPanelFeatureDetails(props: {
  readonly stage: NonNullable<ReturnType<typeof useCrewStageContext>>;
  readonly busy: boolean;
  readonly run: (
    action: Parameters<NonNullable<ReturnType<typeof useCrewStageContext>>["run"]>[0],
    input?: Parameters<NonNullable<ReturnType<typeof useCrewStageContext>>["run"]>[1],
  ) => Promise<void>;
  readonly openThread: (threadId: ThreadId) => void;
  readonly onEditWorkflow: () => void;
}) {
  const { stage, busy, run, openThread } = props;
  const { thread } = stage;
  const snapshot = stage.snapshot!;
  const rows = featureStageRows(snapshot);
  const activeTask = snapshot.activeStepId
    ? snapshot.definition.steps[snapshot.activeStepId]
    : undefined;
  const supervisor =
    activeTask?.type === "task" ? snapshot.definition.roles[activeTask.role]?.supervisor : null;
  const pullRequest = thread.linkedPullRequest ?? thread.branchPullRequest ?? null;
  const footer = (["start-now", "pause", "resume", "cancel", "reopen"] as const).filter((action) =>
    stage.actions.includes(action),
  );
  return (
    <>
      {snapshot.outputs && snapshot.outputs.length > 0 ? (
        <section className="flex flex-col gap-1">
          <SectionTitle>Outputs</SectionTitle>
          <ul className="flex flex-col">
            {snapshot.outputs.map((output) => (
              <li key={output.kind === "file" ? `file:${output.path}` : `diff:${output.stepId}`}>
                <button
                  type="button"
                  className={cn(ROW_CLASS, "w-full cursor-pointer text-left hover:bg-accent/50")}
                  onClick={() =>
                    output.kind === "file"
                      ? useRightPanelStore
                          .getState()
                          .openFile(scopeThreadRef(thread.environmentId, thread.id), output.path)
                      : openThread(output.threadId)
                  }
                >
                  <span aria-hidden className="size-4 shrink-0" />
                  {output.kind === "file" ? (
                    <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileDiffIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {output.kind === "file" ? (
                      <>
                        {output.path}
                        <span className="text-muted-foreground">
                          {" "}
                          · v{output.version} · {formatStageName(output.stepId)}
                        </span>
                      </>
                    ) : (
                      <>
                        {formatStageName(output.stepId)} diff{" "}
                        <span className="text-xs text-diff-addition-foreground tabular-nums">
                          +{output.additions}
                        </span>{" "}
                        <span className="text-xs text-diff-deletion-foreground tabular-nums">
                          −{output.deletions}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">Open</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-1">
        <SectionTitle>Workspace</SectionTitle>
        <dl className="flex flex-col">
          <WorkspaceRow icon={GitBranchIcon} label="Branch" value={thread.branch} />
          <WorkspaceRow
            icon={PullRequestGlyph.pullRequest}
            label="Pull request"
            value={pullRequest ? `#${pullRequest.number}` : null}
          />
          <WorkspaceRow
            icon={MessageCircleQuestionIcon}
            label="Questions go to"
            value={supervisor ? `${formatStageName(supervisor)}, then you` : "You"}
          />
        </dl>
        {snapshot.executionError ? (
          <p role="alert" className="px-2 text-xs break-words text-destructive">
            {snapshot.executionError}
          </p>
        ) : null}
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t pt-3 px-2">
        {footer.map((action) =>
          // A finished feature reopens as a follow-up, at a stage you pick.
          action === "reopen" && snapshot.completed ? (
            <Menu key={action}>
              <MenuTrigger
                disabled={busy}
                render={<Button size="xs" variant="outline" />}
                title={CREW_ACTION_COPY.reopen.description}
              >
                Reopen at…
              </MenuTrigger>
              <MenuPopup align="start">
                {rows.map((row) => (
                  <MenuItem
                    key={row.stepId}
                    onClick={() => void run("reopen", { stepId: row.stepId })}
                  >
                    {row.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <Button
              key={action}
              size="xs"
              variant={action === "cancel" ? "destructive-outline" : "outline"}
              disabled={busy}
              title={CREW_ACTION_COPY[action].description}
              onClick={() => void run(action)}
            >
              {CREW_ACTION_COPY[action].label}
            </Button>
          ),
        )}
        <Button size="xs" variant="ghost" onClick={props.onEditWorkflow}>
          Edit workflow
        </Button>
      </footer>
    </>
  );
}
