import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { isQuietCompletion } from "./quietCompletion.ts";

const leadId = ThreadId.make("thread:lead");
const top = { parentThreadId: null, relationshipToParent: null, rootThreadId: leadId };
const feature = { id: "feature:1", title: "Checkout" };
const under = (parent: ThreadId, listed?: true) => ({
  parentThreadId: parent,
  relationshipToParent: "subagent" as const,
  rootThreadId: parent,
  ...(listed ? { listed } : {}),
});

describe("isQuietCompletion", () => {
  it.each([
    ["a plain thread finishing", { lineage: top }, false, false],
    ["a feature lead stopping with its crew idle", { lineage: top, feature }, false, false],
    ["a feature lead whose crew result is on its way", { lineage: top, feature }, true, true],
    [
      "a crew member's turn ending",
      { lineage: under(leadId), feature: { ...feature, member: "Builder" } },
      false,
      true,
    ],
    ["a project manager's task in another project", { lineage: under(leadId, true) }, false, true],
    [
      "a child feature's lead, which reports to its parent's lead",
      { lineage: top, feature: { ...feature, parentFeatureId: "feature:parent" } },
      false,
      true,
    ],
    [
      "a task a linked environment delegated here",
      {
        lineage: top,
        delegatedFrom: {
          environmentId: EnvironmentId.make("environment:mac"),
          threadId: leadId,
          title: "Headquarters",
        },
      },
      false,
      true,
    ],
  ] as const)("%s", (_name, thread, delegatedResultOwed, quiet) => {
    expect(isQuietCompletion({ thread, delegatedResultOwed })).toBe(quiet);
  });
});
