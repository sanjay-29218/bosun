import {
  CREW_STATE_LABELS,
  featureStageRows,
  formatStageName,
} from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";

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
  cancelled: "Cancelled",
  "awaiting-approval": "Approval",
  "limit-reached": "Your call",
  "taken-over": "Yours",
  skipped: "Skipped",
};

/** The breadcrumb's stage segment: a menu of the feature's stage threads. */
export function CrewStageBreadcrumb({ stage }: { readonly stage: CrewStage }) {
  const navigate = useNavigate();
  const rows = stage.snapshot ? featureStageRows(stage.snapshot) : [];
  const name = formatStageName(stage.crew.stepId);
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Stage ${name}, switch stage thread`}
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
            const row = rows.find((item) => item.threadId === threadId);
            if (!row?.threadId) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(stage.thread.environmentId, row.threadId),
              ),
            });
          }}
        >
          {rows.length === 0 ? (
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
