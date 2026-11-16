import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:features-page-preferences:v1";

const BoardLayout = Schema.Literals(["board", "list"]);
export type BoardTab = "work" | "issues";

const FeaturesPagePreferencesSchema = Schema.Struct({
  /** The layout from before each tab kept its own; read as both tabs' default. */
  featureLayout: Schema.optionalKey(BoardLayout),
  /** Each tab's layout, as columns or as stacked sections. */
  layoutByTab: Schema.optionalKey(
    Schema.Struct({
      work: Schema.optionalKey(BoardLayout),
      issues: Schema.optionalKey(BoardLayout),
    }),
  ),
  /** The tab last open on each project's board, by `environmentId:projectId`, or `all`. */
  tabByProject: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Literals(["work", "issues"])),
  ),
  /** The workflow last started from each project's board. */
  workflowByProject: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** What New todo files when the project has GitHub issues; a ticket otherwise. */
  newTodoKind: Schema.optionalKey(Schema.Literals(["ticket", "issue"])),
});
export type FeaturesPagePreferences = typeof FeaturesPagePreferencesSchema.Type;

const DEFAULT_PREFERENCES: FeaturesPagePreferences = {};

export function readFeaturesPagePreferences(): FeaturesPagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, FeaturesPagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Features page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveFeaturesPagePreferences(preferences: FeaturesPagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, FeaturesPagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Features page preferences.", error);
  }
}

/** Reads the preferences fresh, so a write from another component isn't lost. */
export function updateFeaturesPagePreferences(
  patch: (current: FeaturesPagePreferences) => Partial<FeaturesPagePreferences>,
): FeaturesPagePreferences {
  const current = readFeaturesPagePreferences();
  const next = { ...current, ...patch(current) };
  saveFeaturesPagePreferences(next);
  return next;
}
