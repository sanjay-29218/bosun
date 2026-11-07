import { issueRef, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { IssueClosedReason } from "@t3tools/contracts";
import { ChevronDownIcon, CircleCheckIcon, RotateCcwIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

type TodoRef = Pick<EnvironmentIssue, "environmentId" | "projectId" | "number" | "ticketId">;

export const failureText = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message.replace(/^\w*Error: /, "") : fallback;
};

/** Opens or closes an issue on its host, or a ticket here. */
const setTodoState = (todo: TodoRef, state: "open" | "closed", reason?: IssueClosedReason) =>
  todo.ticketId
    ? runAtomCommand(
        appAtomRegistry,
        featuresEnvironment.updateTicket,
        {
          environmentId: todo.environmentId,
          input: {
            projectId: todo.projectId,
            ticketId: todo.ticketId,
            state,
            ...(reason ? { closedReason: reason } : {}),
          },
        },
        { reportFailure: false },
      )
    : runAtomCommand(
        appAtomRegistry,
        featuresEnvironment.setIssueState,
        {
          environmentId: todo.environmentId,
          input: {
            projectId: todo.projectId,
            number: todo.number,
            state,
            ...(reason ? { reason } : {}),
          },
        },
        { reportFailure: false },
      );

const changeWithToast = async (
  todo: TodoRef,
  state: "open" | "closed",
  reason?: IssueClosedReason,
) => {
  const ref = issueRef(todo);
  const result = await setTodoState(todo, state, reason);
  if (result._tag === "Success") {
    if (state === "open") {
      toastManager.add({ type: "success", title: `Reopened ${ref}` });
      return true;
    }
    const id = toastManager.add({
      type: "success",
      title: `Closed ${ref} as ${reason === "not_planned" ? "not planned" : "completed"}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void changeWithToast(todo, "open");
        },
      },
    });
    return true;
  }
  if (!isAtomCommandInterrupted(result)) {
    toastManager.add({
      type: "error",
      title: `Could not ${state === "open" ? "reopen" : "close"} ${ref}`,
      description: failureText(result, "Nothing changed."),
    });
  }
  return false;
};

/**
 * Runs one change at a time. A success stays pending: the item leaves its column, or its sheet
 * swaps the button, once the refreshed list arrives, so it can't be sent twice meanwhile.
 */
function useTodoChange(todo: TodoRef) {
  const [pending, setPending] = useState(false);
  const allowed = useAtomValue(
    (todo.ticketId
      ? featuresEnvironment.updateTicket
      : featuresEnvironment.setIssueState
    ).permissionAtom(todo.environmentId),
  );
  const run = (state: "open" | "closed", reason?: IssueClosedReason) => {
    if (pending || !allowed) return;
    setPending(true);
    void changeWithToast(todo, state, reason).then((changed) => {
      if (!changed) setPending(false);
    });
  };
  return { pending, allowed, run };
}

export function ReopenTodoButton(props: { readonly todo: TodoRef }) {
  const { pending, allowed, run } = useTodoChange(props.todo);
  return (
    <Button size="xs" variant="outline" disabled={pending || !allowed} onClick={() => run("open")}>
      {pending ? <Spinner aria-hidden /> : <RotateCcwIcon aria-hidden />}
      Reopen
    </Button>
  );
}

/** Close as completed in one click; the chevron offers not planned. Undo reopens it. */
export function CloseTodoButton(props: { readonly todo: TodoRef }) {
  const { pending, allowed, run } = useTodoChange(props.todo);
  const close = (reason: IssueClosedReason) => run("closed", reason);
  return (
    <Group aria-label={`Close ${issueRef(props.todo)}`} aria-busy={pending}>
      <Button
        size="xs"
        variant="outline"
        disabled={pending || !allowed}
        onClick={() => close("completed")}
      >
        {pending ? <Spinner aria-hidden /> : <CircleCheckIcon aria-hidden />}
        Close
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          disabled={pending || !allowed}
          render={<Button size="icon-xs" variant="outline" aria-label="More ways to close" />}
        >
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => close("completed")}>Close as completed</MenuItem>
          <MenuItem onClick={() => close("not_planned")}>Close as not planned</MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}
