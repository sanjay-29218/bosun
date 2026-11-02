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
import { useRef, useState } from "react";

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
}) {
  const bare = variant === "document";
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(value.length);
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
      <div
        role="toolbar"
        aria-label={`${label} formatting`}
        className={cn(
          "flex flex-wrap items-center gap-0.5",
          bare
            ? "-ms-1.5 mb-1 opacity-0 transition-opacity group-focus-within/editor:opacity-100 group-hover/editor:opacity-100 pointer-coarse:opacity-100"
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
          className={cn(bare ? "max-h-none" : "max-h-80", SIZE_CLASS_NAMES[size])}
          onChange={(nextValue, nextCursor) => {
            setCursor(nextCursor);
            if (nextValue !== value) onChange(nextValue);
          }}
          onPaste={noop}
        />
      </div>
    </div>
  );
}
