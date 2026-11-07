import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  BoldIcon,
  HeadingIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  SquareCodeIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";

import { cn } from "~/lib/utils";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerFormat,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "./composerContextPresentation";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

const FORMAT_ACTIONS: ReadonlyArray<{ format: ComposerFormat; label: string; icon: LucideIcon }> = [
  { format: "heading", label: "Heading", icon: HeadingIcon },
  { format: "bold", label: "Bold", icon: BoldIcon },
  { format: "italic", label: "Italic", icon: ItalicIcon },
  { format: "bulletList", label: "Bulleted list", icon: ListIcon },
  { format: "orderedList", label: "Numbered list", icon: ListOrderedIcon },
  { format: "taskList", label: "Checklist", icon: ListTodoIcon },
  { format: "codeBlock", label: "Code block", icon: SquareCodeIcon },
];

// The composer sets its own min height, including under the redesign variant, so both are overridden.
const SIZE_CLASS_NAMES = {
  sm: "min-h-16 redesign:min-h-16",
  md: "min-h-32 redesign:min-h-32",
  lg: "min-h-40 redesign:min-h-40",
} as const;

function noop() {}

/**
 * Markdown editor for agent instructions and prompts. Renders formatting live and reads and writes
 * the same Markdown string a textarea would, with mentions and skills kept as literal text.
 */
export function InstructionsEditor({
  id,
  label,
  value,
  onChange,
  placeholder = "",
  disabled = false,
  maxLength,
  size = "md",
  variant = "field",
  autoFocus = false,
  onPasteImage,
}: {
  /** Id for the field's label to reference (`htmlFor`). */
  readonly id?: string;
  /** Accessible name of the text box, usually the field's visible label. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly size?: keyof typeof SIZE_CLASS_NAMES;
  /** "document" drops the box and grows with its text; its toolbar shows on hover and focus. */
  readonly variant?: "field" | "document";
  /**
   * Focuses it when it mounts, for an editor opened from its rendered text: the caret goes to the
   * clicked point, or to the end.
   */
  readonly autoFocus?: boolean | { readonly x: number; readonly y: number };
  /**
   * Stores a pasted image and resolves with its URL, or null when it couldn't. The editor holds a
   * placeholder at the caret meanwhile. Without it, pasted images are ignored.
   */
  readonly onPasteImage?: (file: File) => Promise<string | null>;
}) {
  const bare = variant === "document";
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const openedAt = useRef(autoFocus);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Moves DOM focus into the editor once, when it opens.
  useEffect(() => {
    const point = openedAt.current;
    if (typeof point === "object") editorRef.current?.focusAtPoint(point);
    else if (point) editorRef.current?.focusAtEnd();
  }, []);
  const [cursor, setCursor] = useState(value.length);
  // Writes go through the editor's live text, which may be ahead of `value` by then.
  const replaceText = (start: number, end: number, text: string) => {
    const live = editorRef.current?.readSnapshot();
    if (!live) return;
    const shift = live.cursor >= end ? text.length - (end - start) : 0;
    setCursor(live.cursor + shift);
    onChange(live.value.slice(0, start) + text + live.value.slice(end));
  };
  const pasteImages = (event: ClipboardEvent<HTMLElement>) => {
    if (!onPasteImage) return;
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    const live = editorRef.current?.readSnapshot();
    if (files.length === 0 || !live) return;
    event.preventDefault();
    const at = live.expandedCursor;
    // An image reads as its own block, so one pasted mid-line starts a new line. Each placeholder
    // carries the line break before it, so a failed upload takes that out with it.
    const lineStart = at === 0 || live.value[at - 1] === "\n";
    const uploads = files.map((file, index) => ({
      file,
      alt: file.name.replace(/\.\w+$/u, "") || "image",
      before: index === 0 && lineStart ? "" : "\n",
      // Unique, so each upload finds its own placeholder however the text moved meanwhile.
      placeholder: `![Uploading ${file.name || "image"}… ${Date.now().toString(36)}${index}]()`,
    }));
    replaceText(at, at, uploads.map((upload) => upload.before + upload.placeholder).join(""));
    for (const upload of uploads) {
      void onPasteImage(upload.file).then((url) => {
        const value = editorRef.current?.readSnapshot().value ?? "";
        const held = upload.before + upload.placeholder;
        const [found, start] = value.includes(held)
          ? [held, value.indexOf(held)]
          : [upload.placeholder, value.indexOf(upload.placeholder)];
        if (start < 0) return;
        const image = `![${upload.alt}](${url})`;
        replaceText(
          start,
          start + found.length,
          url === null ? "" : found === held ? upload.before + image : image,
        );
      });
    }
  };
  // A document's toolbar sits under its text, so showing it never moves the text.
  const toolbar = (
    <div
      role="toolbar"
      aria-label={`${label} formatting`}
      className={cn(
        "flex flex-wrap items-center gap-0.5",
        bare
          ? "-ms-1.5 mt-1 opacity-0 transition-opacity group-focus-within/editor:opacity-100 group-hover/editor:opacity-100 pointer-coarse:opacity-100"
          : "border-b border-input px-1.5 py-1",
      )}
    >
      {FORMAT_ACTIONS.map(({ format, label: actionLabel, icon: Icon }) => (
        <Tooltip key={format}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={actionLabel}
                disabled={disabled}
                // Keep focus and the selection in the editor.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => editorRef.current?.applyFormat(format)}
              >
                <Icon />
              </Button>
            }
          />
          <TooltipPopup>{actionLabel}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
  return (
    <div
      id={id}
      className={cn(
        "w-full min-w-0 text-foreground",
        bare
          ? "group/editor"
          : "rounded-lg border border-input bg-background shadow-xs/5 ring-ring/24 transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-inset dark:bg-input/32",
        disabled && "opacity-64",
      )}
    >
      {bare ? null : toolbar}
      <div className={bare ? undefined : "px-3 py-2"}>
        <ComposerPromptEditor
          editorRef={editorRef}
          ariaLabel={label}
          value={value}
          cursor={cursor}
          richTextEnabled
          inlineChips={false}
          {...(maxLength === undefined ? {} : { maxLength })}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={NO_SKILLS}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(bare ? "composer-document max-h-none" : "max-h-80", SIZE_CLASS_NAMES[size])}
          onChange={(nextValue, nextCursor) => {
            setCursor(nextCursor);
            if (nextValue !== value) onChange(nextValue);
          }}
          onPaste={onPasteImage ? pasteImages : noop}
        />
      </div>
      {bare ? toolbar : null}
    </div>
  );
}
