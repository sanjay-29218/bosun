import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { PendingApproval } from "../../lib/threadActivity";

/**
 * The layout of every card that waits on the user above the composer: tool approvals,
 * Crew gates, failures and Your call. `danger` turns the kicker red for failures.
 */
export function ApprovalCardLayout(props: {
  readonly kicker: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly note?: ReactNode;
  readonly tone?: "default" | "danger";
  readonly children: ReactNode;
}) {
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text
        className={cn(
          "font-t3-bold text-2xs uppercase tracking-[1.1px]",
          props.tone === "danger" ? "text-danger-foreground" : "text-foreground-secondary",
        )}
      >
        {props.kicker}
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">{props.title}</Text>
      {props.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      ) : null}
      {props.note}
      <View className="flex-row flex-wrap gap-2.5">{props.children}</View>
    </View>
  );
}

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  return (
    <ApprovalCardLayout
      kicker="Approval needed"
      title={props.approval.appName ?? props.approval.requestKind}
      detail={props.approval.detail}
      note={
        <>
          {props.approval.reason ? (
            <Text className="font-sans text-xs leading-normal text-warning-foreground">
              {props.approval.reason}
            </Text>
          ) : null}
          {props.approval.fullAccessOverride ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: explanationOpen }}
              onPress={() => setExplanationOpen((open) => !open)}
            >
              <Text className="font-t3-bold text-xs text-foreground-secondary underline">
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </Text>
              {explanationOpen ? (
                <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
                  {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          {!canRespond ? (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              The provider process for this request is no longer available. Interrupt or restart the
              run to continue.
            </Text>
          ) : null}
          {warning ? (
            <Text className="font-sans text-xs leading-normal text-warning-foreground">
              {warning}
            </Text>
          ) : null}
        </>
      }
    >
      {options.map((option) => (
        <Button
          key={option.decision}
          label={option.label}
          tone={
            option.decision === "accept"
              ? "primary"
              : option.decision === "decline"
                ? "danger"
                : "secondary"
          }
          disabled={disabled || !props.canOperateThread}
          onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
        />
      ))}
      {!props.canOperateThread ? (
        <Text className="w-full font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </ApprovalCardLayout>
  );
}
