// Tailwind 500 hues that read on both themes.
const FEATURE_TAG_COLORS = [
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#6366f1",
  "#a855f7",
  "#ec4899",
];

/** A feature tag's color: its ID hashed into a fixed palette, so every client agrees. */
export function featureTagColor(featureId: string): string {
  let hash = 0;
  for (let index = 0; index < featureId.length; index += 1) {
    hash = (hash * 31 + featureId.charCodeAt(index)) >>> 0;
  }
  return FEATURE_TAG_COLORS[hash % FEATURE_TAG_COLORS.length]!;
}
