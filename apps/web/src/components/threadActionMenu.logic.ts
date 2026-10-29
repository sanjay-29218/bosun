import type { ContextMenuItem, FeatureCardState } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "make-feature"
  | "detach-feature"
  | "feature"
  | "feature-pause"
  | "feature-resume"
  | "feature-cancel"
  | "feature-reopen"
  | "feature-issue"
  | "feature-open-issue"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /**
   * The thread's place in Crew: a feature's current stage, or a plain thread that can
   * become one. Absent for crew threads and servers without features.
   */
  readonly feature?: { readonly isStage: boolean } | null;
  /**
   * Where the thread's feature stands, for pausing, resuming, cancelling or reopening it, and
   * the number of the issue it links, for opening or changing it.
   */
  readonly featureLifecycle?: {
    readonly state: FeatureCardState;
    /** `#12` or `T-12`; null when the feature links none. */
    readonly issueRef: string | null;
  } | null;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A bot's headquarters is permanent, so it can be archived but never deleted. */
  readonly isHeadquarters?: boolean;
}

/** The feature-wide actions that apply in `state`. */
export function featureLifecycleActions(
  state: FeatureCardState,
): ReadonlyArray<"feature-pause" | "feature-resume" | "feature-cancel" | "feature-reopen"> {
  if (state === "done" || state === "cancelled") return ["feature-reopen"];
  if (state === "paused") return ["feature-resume", "feature-cancel"];
  return ["feature-pause", "feature-cancel"];
}

const FEATURE_LIFECYCLE_LABELS = {
  "feature-pause": "Pause feature",
  "feature-resume": "Resume feature",
  "feature-cancel": "Cancel feature…",
  "feature-reopen": "Reopen feature",
} as const;

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(state.featureLifecycle
      ? [
          {
            id: "feature" as const,
            label: "Feature",
            icon: "workflow",
            separatorBefore: true,
            children: [
              ...featureLifecycleActions(state.featureLifecycle.state).map((id) => ({
                id,
                label: FEATURE_LIFECYCLE_LABELS[id],
                ...(id === "feature-cancel" ? { destructive: true } : {}),
              })),
              ...(state.featureLifecycle.issueRef === null
                ? []
                : [
                    {
                      id: "feature-open-issue" as const,
                      label: state.featureLifecycle.issueRef.startsWith("#")
                        ? `Open issue ${state.featureLifecycle.issueRef}`
                        : `Open ${state.featureLifecycle.issueRef}`,
                      separatorBefore: true,
                    },
                  ]),
              {
                id: "feature-issue" as const,
                label: state.featureLifecycle.issueRef === null ? "Link issue…" : "Change issue…",
                ...(state.featureLifecycle.issueRef === null ? { separatorBefore: true } : {}),
              },
            ],
          },
        ]
      : []),
    ...(state.feature
      ? [
          state.feature.isStage
            ? {
                id: "detach-feature" as const,
                label: "Detach from workflow",
                icon: "unlink",
                destructive: true,
                separatorBefore: true,
              }
            : {
                id: "make-feature" as const,
                label: "Make it a feature…",
                icon: "workflow",
                separatorBefore: true,
              },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    ...(state.isHeadquarters
      ? []
      : [{ id: "delete" as const, label: "Delete", destructive: true, icon: "trash" }]),
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
