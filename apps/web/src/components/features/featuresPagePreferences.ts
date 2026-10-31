import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:features-page-preferences:v1";

const FeaturesPagePreferencesSchema = Schema.Struct({
  /** The board as columns, or as stacked sections. */
  featureLayout: Schema.optionalKey(Schema.Literals(["board", "list"])),
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
