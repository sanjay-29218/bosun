import { FEATURE_DELIVERY_WORKFLOW_ID, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon, WorkflowIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { LIBRARY_PATH } from "../sidebar/mainAppLocation";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCrewDraftStore } from "./crewDraftStore";

/**
 * The workflow a feature draft starts on: its pick, else Feature delivery. Null until the
 * environment's workflows load, when the server's default applies.
 */
export function useDraftWorkflow(
  environmentId: EnvironmentId,
  draftId: DraftId | null,
  enabled: boolean,
) {
  const picked = useCrewDraftStore((state) =>
    draftId ? state.workflowByDraftId[draftId] : undefined,
  );
  const workflows =
    useEnvironmentQuery(enabled ? rolesEnvironment.workflows({ environmentId, input: {} }) : null)
      .data ?? [];
  const workflow =
    workflows.find((candidate) => candidate.id === picked) ??
    workflows.find((candidate) => candidate.id === FEATURE_DELIVERY_WORKFLOW_ID) ??
    null;
  return { workflows, workflow };
}

const PLAIN_THREAD = "";

/**
 * A new thread's Workflow picker. On a plain thread it is just an icon; picking a workflow makes
 * the draft a feature, and its label stands in for the model controls its lead doesn't use.
 */
export function ComposerWorkflowPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly size: ComposerControlSize;
  readonly startsFeature: boolean;
}) {
  const navigate = useNavigate();
  const menuProps = useComposerMenuProps();
  const { workflows, workflow } = useDraftWorkflow(props.environmentId, props.draftId, true);
  const setFeatureDraft = useCrewDraftStore((state) => state.setFeatureDraft);
  const setWorkflow = useCrewDraftStore((state) => state.setWorkflow);
  const label = workflow?.name ?? "Feature delivery";
  const pick = (value: string) => {
    if (value === PLAIN_THREAD) {
      setFeatureDraft(props.draftId, false);
      return;
    }
    // Marking a draft a feature clears its pick, so the pick comes second.
    if (!props.startsFeature) setFeatureDraft(props.draftId, true);
    setWorkflow(props.draftId, value);
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={props.size}
                  aria-label={props.startsFeature ? `Workflow: ${label}` : "Start a feature"}
                />
              }
              data-chat-composer-workflow-picker="true"
            />
          }
        >
          <ComposerControlIcon icon={WorkflowIcon} size={props.size} />
          {props.startsFeature ? (
            <span data-composer-control-label className="max-w-40 truncate">
              {label}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {props.startsFeature ? "Change workflow" : "Start a feature with a workflow"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup {...menuProps} side="top" align="start">
        {workflows.length > 0 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Start as</MenuGroupLabel>
              <MenuRadioGroup
                value={
                  props.startsFeature
                    ? (workflow?.id ?? FEATURE_DELIVERY_WORKFLOW_ID)
                    : PLAIN_THREAD
                }
                onValueChange={pick}
              >
                <MenuRadioItem value={PLAIN_THREAD} closeOnClick>
                  Thread
                </MenuRadioItem>
                {workflows.map((candidate) => (
                  <MenuRadioItem key={candidate.id} value={candidate.id} closeOnClick>
                    {candidate.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: LIBRARY_PATH, search: {} })}>
          <LayersIcon />
          Manage workflows…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
