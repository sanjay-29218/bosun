/** An issue a pull request says it closes. */
export interface LinkedIssueRef {
  /** The host a full link names; absent for `#12` and `owner/repo#12`, which mean the PR's. */
  readonly host?: string;
  readonly repository: string;
  readonly number: number;
}

const FENCED_CODE = /```[\s\S]*?```|`[^`\n]*`/gu;
// GitHub's closing keywords, then `#12`, `owner/repo#12` or the issue's link.
const CLOSING_REFERENCE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https?:\/\/([\w.-]+)\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))/giu;

/**
 * The issues a pull request's description closes with GitHub's keywords ("Fixes #12"), in the
 * order it names them. Issues linked only from GitHub's sidebar aren't in the description.
 */
export function linkedIssueRefs(body: string, repository: string): LinkedIssueRef[] {
  const seen = new Set<string>();
  const refs: LinkedIssueRef[] = [];
  for (const match of body.replace(FENCED_CODE, "").matchAll(CLOSING_REFERENCE)) {
    const [, crossRepo, crossNumber, number, linkHost, linkRepo, linkNumber] = match;
    const ref: LinkedIssueRef = {
      ...(linkHost === undefined ? {} : { host: linkHost.toLowerCase() }),
      repository: crossRepo ?? linkRepo ?? repository,
      number: Number(crossNumber ?? number ?? linkNumber),
    };
    const key = `${ref.host ?? ""}/${ref.repository.toLowerCase()}#${ref.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
