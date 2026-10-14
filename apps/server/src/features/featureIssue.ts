import { FeatureIssue, type ThreadFeatureTag } from "@t3tools/contracts";
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
}): ThreadFeatureTag => ({
  id: feature.id,
  title: feature.title,
  ...(feature.issue ? { issue: feature.issue } : {}),
});

/** The issue number in an issue link: GitHub's /owner/repo/issues/N or GitLab's /-/issues/N. */
export const issueNumberFromUrl = (url: URL): number | null => {
  const match = /\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  return match ? Number(match[1]) : null;
};

/** The first issue link in a brief, if any. */
export const firstIssueUrl = (text: string): string | null => {
  for (const match of text.matchAll(/https:\/\/[^\s<>"')\]`]+/g)) {
    const candidate = match[0].replace(/[.,;!?]+$/, "");
    if (URL.canParse(candidate) && issueNumberFromUrl(new URL(candidate)) !== null) {
      return candidate;
    }
  }
  return null;
};
