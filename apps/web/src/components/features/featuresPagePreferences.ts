import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:features-page-preferences:v1";

const ScopePreferences = Schema.Struct({
  /** Show one workflow's stages as the board's columns. */
  workflow: Schema.Boolean,
  /** The workflow the toggle shows; null picks the most used one. */
  workflowId: Schema.NullOr(Schema.String),
});
export type FeaturesScopePreferences = typeof ScopePreferences.Type;

const IssueDisplayPreferences = Schema.Struct({
  layout: Schema.Literals(["list", "board"]),
  /** The list's groups; the board's columns are always status lanes. */
  groupBy: Schema.Literals(["milestone", "status", "none"]),
  /** Draw sub-issues under their parent rather than as rows of their own. */
  nested: Schema.Boolean,
  /** Show the recently closed issues the server reads alongside open ones. */
  showClosed: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
});
export type IssueDisplayPreferences = typeof IssueDisplayPreferences.Type;

const FeaturesPagePreferencesSchema = Schema.Struct({
  /** Keyed by the scoped project, or "all". The Workflow toggle is remembered per project. */
  scopes: Schema.Record(Schema.String, ScopePreferences),
  /** Features as phase columns, or as rows grouped by phase. */
  featureLayout: Schema.optionalKey(Schema.Literals(["board", "list"])),
  issues: Schema.optionalKey(IssueDisplayPreferences),
});
export type FeaturesPagePreferences = typeof FeaturesPagePreferencesSchema.Type;

export const ALL_PROJECTS_SCOPE = "all";
const DEFAULT_PREFERENCES: FeaturesPagePreferences = { scopes: {} };
export const DEFAULT_ISSUE_DISPLAY: IssueDisplayPreferences = {
  layout: "list",
  groupBy: "milestone",
  nested: true,
  showClosed: false,
  labels: true,
  assignees: true,
};
export const DEFAULT_SCOPE_PREFERENCES: FeaturesScopePreferences = {
  workflow: false,
  workflowId: null,
};

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
