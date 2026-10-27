import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  featureLifecycleActions,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("offers either Make it a feature or Detach, and neither outside Crew", () => {
    const featureIds = (feature: { readonly isStage: boolean } | null) =>
      ids({ ...baseState, feature }).filter((id) => id.endsWith("-feature"));
    expect(featureIds({ isStage: false })).toEqual(["make-feature"]);
    expect(featureIds({ isStage: true })).toEqual(["detach-feature"]);
    expect(featureIds(null)).toEqual([]);
    const detach = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      feature: { isStage: true },
    }).find((item) => item.id === "detach-feature");
    expect(detach).toMatchObject({ destructive: true, disabled: true });
  });

  it("opens or changes the feature's issue, and links one when it has none", () => {
    const issueItems = (issueNumber: number | null) =>
      buildThreadActionMenuItems({
        ...baseState,
        featureLifecycle: { state: "working", issueNumber },
      })
        .find((item) => item.id === "feature")
        ?.children?.filter((item) => item.id.includes("issue"))
        .map((item) => item.label);
    expect(issueItems(42)).toEqual(["Open issue #42", "Change issue…"]);
    expect(issueItems(null)).toEqual(["Link issue…"]);
  });
});

describe("featureLifecycleActions", () => {
  it("pauses or cancels a running feature, resumes a paused one and reopens a finished one", () => {
    expect(featureLifecycleActions("working")).toEqual(["feature-pause", "feature-cancel"]);
    expect(featureLifecycleActions("approval")).toEqual(["feature-pause", "feature-cancel"]);
    expect(featureLifecycleActions("paused")).toEqual(["feature-resume", "feature-cancel"]);
    expect(featureLifecycleActions("done")).toEqual(["feature-reopen"]);
    expect(featureLifecycleActions("cancelled")).toEqual(["feature-reopen"]);
  });
});
