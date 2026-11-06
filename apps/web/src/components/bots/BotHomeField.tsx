import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, FolderOpenIcon } from "lucide-react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useServerConfigs } from "../../state/entities";
import { EditorField } from "../settings/CrewAgentFields";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** The bot's own folder on its environment, where its headquarters works. Open runs on that host. */
export function BotHomeField({
  environmentId,
  homePath,
}: {
  readonly environmentId: EnvironmentId;
  readonly homePath: string | null;
}) {
  const availableEditors = useServerConfigs().get(environmentId)?.availableEditors ?? [];
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const open = async (path: string) => {
    const result = await openInPreferredEditor(path);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      title: "Could not open the home folder",
      description: error instanceof Error ? error.message : "The folder was not opened.",
      type: "error",
    });
  };

  return (
    <EditorField label="Home folder">
      {homePath === null ? (
        <p className="text-sm text-muted-foreground">Created when the bot first starts.</p>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {homePath}
          </code>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label="Copy home folder path"
            onClick={() => copyToClipboard(homePath, undefined)}
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
            Copy
          </Button>
          {availableEditors.length > 0 ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void open(homePath)}>
              <FolderOpenIcon />
              Open
            </Button>
          ) : null}
        </div>
      )}
    </EditorField>
  );
}
