import { isClosingFence, parseListPrefix, parseOpeningFence } from "./composer-rich-text-doc";

export type ComposerBlockFormat =
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "codeBlock";

export interface MarkdownSelection {
  start: number;
  end: number;
}

type LinePrefixKind = "heading" | "quote" | "bulletList" | "orderedList" | "taskList";

interface OutputLine {
  text: string;
  /** Source line this output line came from; inserted lines have none. */
  source?: number;
  oldPrefix?: number;
  newPrefix?: number;
}

/** The block prefix the editor parses for a Markdown line, in the parser's order. */
function linePrefix(line: string): { kind: LinePrefixKind; indent: string; length: number } | null {
  const heading = /^#{1,6}[ \t]+/.exec(line);
  if (heading) return { kind: "heading", indent: "", length: heading[0].length };
  const quote = /^>[ \t]*/.exec(line);
  if (quote) return { kind: "quote", indent: "", length: quote[0].length };
  const list = parseListPrefix(line);
  if (!list) return null;
  const kind =
    list.prefix.kind === "task"
      ? "taskList"
      : list.prefix.kind === "ordered"
        ? "orderedList"
        : "bulletList";
  return { kind, indent: list.prefix.indent, length: list.markerLength };
}

/** Line ranges the parser reads as fenced code, fence lines included. */
function codeRegions(lines: readonly string[]): Array<{ open: number; close: number }> {
  const regions: Array<{ open: number; close: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = parseOpeningFence(lines[index]!);
    if (!opening) continue;
    let close = index + 1;
    while (close < lines.length && !isClosingFence(lines[close]!, opening.fence)) close += 1;
    regions.push({ open: index, close: Math.min(close, lines.length - 1) });
    index = close;
  }
  return regions;
}

/**
 * Toggles a block format on the Markdown lines a selection touches, the way a
 * formatting toolbar would. Works on the stored Markdown so the result is
 * exactly what the editor parses and serializes.
 */
export function toggleMarkdownBlockFormat(
  value: string,
  selection: MarkdownSelection,
  format: ComposerBlockFormat,
): { value: string; selection: MarkdownSelection } {
  const lines = value.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (position: number) => {
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1]! <= position) index += 1;
    return index;
  };
  const start = Math.max(0, Math.min(value.length, Math.min(selection.start, selection.end)));
  const end = Math.max(0, Math.min(value.length, Math.max(selection.start, selection.end)));
  const first = lineAt(start);
  let last = lineAt(end);
  // A selection that ends at the start of a line does not include that line.
  if (last > first && end === starts[last]) last -= 1;

  const regions = codeRegions(lines);
  const unchanged = { value, selection: { start, end } };
  let output: OutputLine[];

  if (format === "codeBlock") {
    const enclosing = regions.find((region) => region.open <= first && last <= region.close);
    if (enclosing) {
      const closed =
        enclosing.close > enclosing.open &&
        isClosingFence(lines[enclosing.close]!, parseOpeningFence(lines[enclosing.open]!)!.fence);
      output = lines.flatMap((text, source) =>
        source === enclosing.open || (closed && source === enclosing.close)
          ? []
          : [{ text, source }],
      );
    } else {
      if (regions.some((region) => region.open <= last && first <= region.close)) return unchanged;
      output = lines.flatMap((text, source) => [
        ...(source === first ? [{ text: "```" }] : []),
        { text, source },
        ...(source === last ? [{ text: "```" }] : []),
      ]);
    }
  } else {
    const inCode = (index: number) =>
      regions.some((region) => region.open <= index && index <= region.close);
    const targets: number[] = [];
    for (let index = first; index <= last; index += 1) {
      if (inCode(index)) continue;
      if (first !== last && lines[index]!.trim() === "") continue;
      targets.push(index);
    }
    if (targets.length === 0) return unchanged;
    const prefixes = new Map(targets.map((index) => [index, linePrefix(lines[index]!)]));
    const remove = targets.every((index) => prefixes.get(index)?.kind === format);
    let ordinal = 0;
    output = lines.map((text, source) => {
      if (!prefixes.has(source)) return { text, source };
      const prefix = prefixes.get(source) ?? null;
      const oldPrefix = prefix?.length ?? 0;
      const indent = prefix?.indent ?? "";
      ordinal += 1;
      const marker = remove
        ? indent
        : format === "heading"
          ? "## "
          : format === "bulletList"
            ? `${indent}- `
            : format === "orderedList"
              ? `${indent}${ordinal}. `
              : `${indent}- [ ] `;
      return {
        text: marker + text.slice(oldPrefix),
        source,
        oldPrefix,
        newPrefix: marker.length,
      };
    });
  }

  const nextStarts: number[] = [];
  const sourceIndex = new Map<number, number>();
  offset = 0;
  output.forEach((line, index) => {
    nextStarts.push(offset);
    offset += line.text.length + 1;
    if (line.source !== undefined) sourceIndex.set(line.source, index);
  });
  const map = (position: number) => {
    let line = lineAt(position);
    // Removed fence lines map to the next kept line, or the end of the previous one.
    while (line < lines.length && !sourceIndex.has(line)) line += 1;
    if (line >= lines.length) return Math.max(0, offset - 1);
    const target = sourceIndex.get(line)!;
    const out = output[target]!;
    const column = Math.max(0, position - starts[line]!);
    const oldPrefix = out.oldPrefix ?? 0;
    const newPrefix = out.newPrefix ?? 0;
    const nextColumn =
      column < oldPrefix ? newPrefix : Math.min(out.text.length, column - oldPrefix + newPrefix);
    return nextStarts[target]! + (position < starts[line]! ? 0 : nextColumn);
  };
  return {
    value: output.map((line) => line.text).join("\n"),
    selection: { start: map(start), end: map(end) },
  };
}
