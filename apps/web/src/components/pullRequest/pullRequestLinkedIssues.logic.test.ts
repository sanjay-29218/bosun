import { describe, expect, it } from "vite-plus/test";

import { linkedIssueRefs } from "./pullRequestLinkedIssues.logic";

describe("linkedIssueRefs", () => {
  it.each([
    ["Fixes #12", [{ repository: "acme/web", number: 12 }]],
    ["closes: #3 and resolved #4", [3, 4].map((number) => ({ repository: "acme/web", number }))],
    ["Fixes acme/api#7", [{ repository: "acme/api", number: 7 }]],
    ["Resolves https://github.com/acme/web/issues/9", [{ repository: "acme/web", number: 9 }]],
    ["Fixes #12. Also fixes #12", [{ repository: "acme/web", number: 12 }]],
    ["Mentions #12 without a keyword", []],
    ["```\nfixes #12\n```\nand `closes #13`", []],
    ["prefixes #12", []],
  ])("reads %j", (body, expected) => {
    expect(linkedIssueRefs(body, "acme/web")).toEqual(expected);
  });
});
