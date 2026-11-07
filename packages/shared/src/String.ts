export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  return `${characters.slice(0, maxLength).join("")}...`;
}

const LAST_LINE_MAX_LENGTH = 160;
// Lines that carry no words: code fences and horizontal rules.
const STRUCTURAL_LINE = /^(?:`{3,}|~{3,})\S*$|^(?:[-*_]\s*){3,}$/;
const LEADING_MARKDOWN = /^(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+|\[[ xX]\]\s+)+/;

/** A message's last line of prose for a one-line preview, without markdown markers. */
export function lastMessageLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index]!.trim();
    if (raw === "" || STRUCTURAL_LINE.test(raw)) continue;
    const line = raw
      .replace(LEADING_MARKDOWN, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "") continue;
    const characters = Array.from(line);
    return characters.length <= LAST_LINE_MAX_LENGTH
      ? line
      : `${characters.slice(0, LAST_LINE_MAX_LENGTH - 1).join("")}…`;
  }
  return "";
}
