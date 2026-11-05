import { FeatureIssue, type ThreadFeatureTag, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const issueJson = Schema.fromJsonString(FeatureIssue);
export const encodeFeatureIssue = Schema.encodeSync(issueJson);
const decodeIssue = Schema.decodeUnknownOption(issueJson);

/** A stored `issue_json`; unreadable JSON reads as no issue. */
export const decodeFeatureIssue = (json: string | null): FeatureIssue | null =>
  json === null ? null : Option.getOrNull(decodeIssue(json));

/** The tag a feature's threads carry. Every write sends all of it, so none drops the issue. */
export const featureTag = (feature: {
  readonly id: string;
  readonly title: string;
  readonly issue: FeatureIssue | null;
  readonly requesterThreadId?: ThreadId | null | undefined;
}): ThreadFeatureTag => ({
  id: feature.id,
  title: feature.title,
  ...(feature.issue ? { issue: feature.issue } : {}),
  ...(feature.requesterThreadId ? { requesterThreadId: feature.requesterThreadId } : {}),
});

/** The issue number in an issue link: GitHub's /owner/repo/issues/N or GitLab's /-/issues/N. */
export const issueNumberFromUrl = (url: URL): number | null => {
  const match = /\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  return match ? Number(match[1]) : null;
};

/** The first issue link in a brief, if any. */
const firstIssueUrl = (text: string): string | null => {
  for (const match of text.matchAll(/https:\/\/[^\s<>"')\]`]+/g)) {
    const candidate = match[0].replace(/[.,;!?]+$/, "");
    if (URL.canParse(candidate) && issueNumberFromUrl(new URL(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
};

/** The first issue link in a brief, else a `Ticket T-<number>` line, if any. */
export const firstIssueRef = (text: string): string | null =>
  firstIssueUrl(text) ?? /^Ticket (T-[1-9]\d*)\s*$/mu.exec(text)?.[1] ?? null;

/** `#56` or `56`: an issue of the project's own repository. */
export const repositoryIssueNumber = (ref: string): number | null => {
  const match = /^#?([1-9]\d*)$/u.exec(ref.trim());
  return match ? Number(match[1]) : null;
};

const TRACKER_KEY = /^([A-Z][A-Z0-9]{0,9})-([1-9]\d*)$/u;

/**
 * An issue of a tracker the project's host can't read, such as Linear: a Linear issue link or a
 * bare key like `LIN-123`. Only what the reference itself says is kept.
 */
export const trackerIssue = (ref: string): FeatureIssue | null => {
  const candidate = ref.trim();
  const keyed = (key: string, url: string, title: string): FeatureIssue | null => {
    const match = TRACKER_KEY.exec(key);
    if (!match) return null;
    const number = Number(match[2]);
    return { url, key, number, title, state: "open", milestone: null, subIssues: null };
  };
  if (!URL.canParse(candidate)) return keyed(candidate, "", "");
  const url = new URL(candidate);
  if (url.hostname !== "linear.app") return null;
  const match = /^\/([^/]+)\/issue\/([^/]+)(?:\/([^/]+))?\/?$/u.exec(url.pathname);
  if (!match) return null;
  const title = (match[3] ?? "").replace(/-/g, " ").trim();
  return keyed(
    match[2]!.toUpperCase(),
    `https://linear.app/${match[1]}/issue/${match[2]!.toUpperCase()}`,
    title && title[0]!.toUpperCase() + title.slice(1),
  );
};
