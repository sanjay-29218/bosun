import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { readLocalApi } from "../../localApi";
import { featuresEnvironment } from "../../state/features";
import { useEnvironmentQuery } from "../../state/query";
import { openTodo, openTodoInPanel } from "../features/todoDialogs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { LinkedIssueRef } from "./pullRequestLinkedIssues.logic";

/**
 * The issues a pull request's description closes, as chips. One in the pull request's own
 * repository opens beside it in the thread's panel, or in the todo sheet outside a thread; a Cmd-
 * or Ctrl-click, a middle click, or one in another repository opens it on its host.
 */
export function PullRequestLinkedIssues(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly refs: ReadonlyArray<LinkedIssueRef>;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { reference } = props;
  const issues = useEnvironmentQuery(
    featuresEnvironment.issues({
      environmentId: props.environmentId,
      input: { projectId: reference.projectId },
    }),
  );
  const host = reference.host ?? "github.com";

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {props.refs.map((ref) => {
        const url = `https://${host}/${ref.repository}/issues/${ref.number}`;
        const local = ref.repository.toLowerCase() === reference.repository.toLowerCase();
        // The project's list names issues in its repository, which is this pull request's.
        const issue = local
          ? (issues.data?.issues.find((candidate) => candidate.number === ref.number) ?? null)
          : null;
        const label = local ? `#${ref.number}` : `${ref.repository}#${ref.number}`;
        const open = (event: MouseEvent<HTMLButtonElement>) => {
          if (event.metaKey || event.ctrlKey || event.button === 1 || !local) {
            void readLocalApi()?.shell.openExternal(url);
            return;
          }
          const todo = {
            environmentId: props.environmentId,
            projectId: reference.projectId,
            number: ref.number,
            url,
          };
          if (props.threadRef) openTodoInPanel(props.threadRef, todo, label);
          else openTodo(todo);
        };
        const closed = issue?.state === "closed";
        const Icon = closed ? CircleCheckIcon : CircleDotIcon;
        return (
          <Tooltip key={url}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={open}
                  onAuxClick={(event) => {
                    if (event.button === 1) open(event);
                  }}
                  className="inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/70 px-2 text-muted-foreground outline-none hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <Icon
                aria-hidden
                className={closed ? "size-3 text-primary" : "size-3 text-success"}
              />
              <span className="shrink-0 font-mono">{label}</span>
              {issue ? (
                <span className="min-w-0 truncate text-foreground">{issue.title}</span>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {local ? "Open here · Cmd-click opens on GitHub" : "Open on GitHub"}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}
