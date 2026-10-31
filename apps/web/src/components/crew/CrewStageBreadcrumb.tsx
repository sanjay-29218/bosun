import {
  CREW_STATE_LABELS,
  featureStageRows,
  formatStageName,
} from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { workGroupLead } from "@t3tools/client-runtime/state/work-groups";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";

import { useWorkGroup } from "../../state/workGroup";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import type { CrewStage } from "./useCrewStage";

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "Next",
  running: "Working",
  "needs-input": "Input",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  "awaiting-approval": "Approval",
  "limit-reached": "Your call",
  "taken-over": "Yours",
  skipped: "Skipped",
};

/**
 * The breadcrumb's crew segment: where this thread sits in its feature, as a menu of the lead's
 * thread and the stage threads.
 */
export function CrewStageBreadcrumb({ stage }: { readonly stage: CrewStage }) {
  const navigate = useNavigate();
  const group = useWorkGroup(scopeThreadRef(stage.thread.environmentId, stage.thread.id));
  const lead = group ? workGroupLead(group) : null;
  const rows = stage.snapshot ? featureStageRows(stage.snapshot) : [];
  const name = stage.crew
    ? formatStageName(stage.crew.stepId)
    : stage.thread.id === lead?.id
      ? "Lead"
      : (stage.thread.crewRequest?.member ?? "Helper");
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${name}, switch to the lead or a stage thread`}
            className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <WorkspaceBreadcrumbText>{name}</WorkspaceBreadcrumbText>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={stage.thread.id}
          onValueChange={(threadId: string) => {
            if (threadId.startsWith("stage:")) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(stage.thread.environmentId, ThreadId.make(threadId)),
              ),
            });
          }}
        >
          {lead ? (
            <MenuRadioItem value={lead.id}>
              <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                <span className="truncate">{lead.title}</span>
                <span className="text-xs text-muted-foreground">Lead</span>
              </span>
            </MenuRadioItem>
          ) : null}
          {rows.length === 0 && stage.crew ? (
            <MenuRadioItem value={stage.thread.id}>
              {name} · {CREW_STATE_LABELS[stage.crew.state]}
            </MenuRadioItem>
          ) : (
            rows.map((row) => (
              <MenuRadioItem
                key={row.stepId}
                value={row.threadId ?? `stage:${row.stepId}`}
                disabled={row.threadId === null}
              >
                <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                  <span className="truncate">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {STEP_STATUS_LABELS[row.status] ?? row.status}
                  </span>
                </span>
              </MenuRadioItem>
            ))
          )}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
