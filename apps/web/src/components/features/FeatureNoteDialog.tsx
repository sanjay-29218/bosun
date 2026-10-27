import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import type { FeatureNoteRequest } from "./useFeatureActions";

const COPY = {
  "request-changes": {
    title: "Request changes",
    description: "Describe the changes you want. The stage runs again with your note.",
    submit: "Request changes",
  },
  answer: {
    title: "Answer",
    description: "Your answer goes to the crew member that asked, and the stage carries on.",
    submit: "Answer",
  },
  "mark-done": {
    title: "Mark done",
    description: "Summarize what you did. The next stage gets your summary as its handoff.",
    submit: "Mark done",
  },
} as const;

/** Asks for the text an action needs, then runs it. */
export function FeatureNoteDialog(props: {
  readonly request: FeatureNoteRequest | null;
  readonly onClose: () => void;
  readonly onSubmit: (request: FeatureNoteRequest, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const request = props.request;
  const copy = request ? COPY[request.action] : null;
  const close = () => {
    setText("");
    props.onClose();
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => (open || busy ? undefined : close())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {copy?.title}
            {request?.outcome ? ` · ${request.outcome.replace(/_/g, " ")}` : ""}
          </DialogTitle>
          <DialogDescription>
            {request ? <span className="font-medium">{request.card.title}</span> : null}
            {request?.card.detail ? ` · ${request.card.detail}` : ""}
            <br />
            {copy?.description}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (!request || !value || busy) return;
            setBusy(true);
            void props
              .onSubmit(request, value)
              .then((done) => {
                if (done) close();
              })
              .finally(() => setBusy(false));
          }}
        >
          <DialogPanel>
            <Textarea
              autoFocus
              aria-label={copy?.title}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={4}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !text.trim()}>
              {copy?.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
