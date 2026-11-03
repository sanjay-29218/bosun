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

/** A feature draft's Workflow picker, in place of the model controls its lead doesn't use. */
export function ComposerWorkflowPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly size: ComposerControlSize;
}) {
  const navigate = useNavigate();
  const menuProps = useComposerMenuProps();
  const { workflows, workflow } = useDraftWorkflow(props.environmentId, props.draftId, true);
  const setWorkflow = useCrewDraftStore((state) => state.setWorkflow);
  const label = workflow?.name ?? "Feature delivery";
  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size={props.size} aria-label={`Workflow: ${label}`} />}
        data-chat-composer-workflow-picker="true"
      >
        <ComposerControlIcon icon={WorkflowIcon} size={props.size} />
        <span data-composer-control-label className="max-w-40 truncate">
          {label}
        </span>
      </MenuTrigger>
      <MenuPopup {...menuProps} side="top" align="start">
        {workflows.length > 0 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Workflow</MenuGroupLabel>
              <MenuRadioGroup
                value={workflow?.id ?? FEATURE_DELIVERY_WORKFLOW_ID}
                onValueChange={(value: string) => setWorkflow(props.draftId, value)}
              >
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
