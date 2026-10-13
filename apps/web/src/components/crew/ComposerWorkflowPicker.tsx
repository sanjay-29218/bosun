import { formatStageName, workflowSummaryLine } from "@t3tools/client-runtime/crew-stage";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { UsersIcon, WorkflowIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { botsEnvironment } from "../../state/bots";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
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
import { resolveDraftWorkflowId, useCrewDraftStore } from "./crewDraftStore";

const NO_WORKFLOW = "";

/** Whether the environment can run workflows; the picker is hidden elsewhere. */
export function useEnvironmentSupportsWorkflows(environmentId: EnvironmentId | null) {
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  return config?.environment.capabilities.workflows === true;
}

/**
 * The workflow a new thread starts on until one is picked. This is the seam for bots
 * (#16): it becomes the active bot's default workflow. Until then there is none.
 */
function useDefaultWorkflowId(): string | null {
  return null;
}

/** The workflow a draft will start, picked or default, if it still exists. */
export function useDraftWorkflow(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly draftId: DraftId | null;
}) {
  const supported = useEnvironmentSupportsWorkflows(input.environmentId);
  const picked = useCrewDraftStore((state) =>
    input.draftId ? state.workflowByDraftId[input.draftId] : null,
  );
  const workflowId = resolveDraftWorkflowId(picked, useDefaultWorkflowId());
  const definitions = useEnvironmentQuery(
    supported && input.projectId
      ? workflowsEnvironment.definitions({
          environmentId: input.environmentId,
          input: { projectId: input.projectId },
        })
      : null,
  ).data;
  return {
    supported: supported && input.projectId !== null && input.draftId !== null,
    definitions: definitions ?? [],
    workflow: definitions?.find((definition) => definition.id === workflowId) ?? null,
  };
}

/**
 * The composer's Workflow picker on a new thread. "No workflow" is a normal thread; a workflow
 * makes the first message the feature's brief.
 */
export function ComposerWorkflowPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftId: DraftId;
  readonly size: ComposerControlSize;
  readonly onManageWorkflows: () => void;
}) {
  const menuProps = useComposerMenuProps();
  const { definitions, workflow } = useDraftWorkflow(props);
  const setWorkflow = useCrewDraftStore((state) => state.setWorkflow);
  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size={props.size} aria-label="Workflow" />}
        data-chat-composer-workflow-picker="true"
      >
        <ComposerControlIcon icon={WorkflowIcon} size={props.size} />
        <span data-composer-control-label className="max-w-40 truncate">
          {workflow?.name ?? "No workflow"}
        </span>
        <ComposerControlChevron size={props.size} />
      </MenuTrigger>
      <MenuPopup {...menuProps} side="top" align="start" className="max-w-sm">
        <MenuRadioGroup
          value={workflow?.id ?? NO_WORKFLOW}
          onValueChange={(value: string) =>
            setWorkflow(props.draftId, value === NO_WORKFLOW ? null : value)
          }
        >
          <MenuRadioItem value={NO_WORKFLOW}>
            <span className="flex min-w-0 flex-col">
              <span>No workflow</span>
              <span className="text-xs text-muted-foreground">
                A normal thread you drive yourself
              </span>
            </span>
          </MenuRadioItem>
          {definitions.map((definition) => (
            <MenuRadioItem key={definition.id} value={definition.id}>
              <span className="flex min-w-0 flex-col">
                <span>{definition.name}</span>
                <span className="text-xs whitespace-normal text-muted-foreground">
                  {workflowSummaryLine(definition)}
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={props.onManageWorkflows}>Manage workflows…</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Stands in for the model picker while a workflow is picked: every role brings its own model,
 * set in the project's crew settings.
 */
export function ComposerCrewControl(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftId: DraftId;
  readonly size: ComposerControlSize;
  readonly onEditCrew: () => void;
}) {
  const menuProps = useComposerMenuProps();
  const { workflow } = useDraftWorkflow(props);
  const templates = useEnvironmentQuery(
    workflow
      ? botsEnvironment.configuration({
          environmentId: props.environmentId,
          input: { projectId: props.projectId },
        })
      : null,
  ).data?.templates;
  if (!workflow) return null;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl size={props.size} aria-label="Crew defaults" />}>
        <ComposerControlIcon icon={UsersIcon} size={props.size} />
        <span data-composer-control-label>Crew defaults</span>
        <ComposerControlChevron size={props.size} />
      </MenuTrigger>
      <MenuPopup {...menuProps} side="top" align="start">
        <MenuGroup>
          <MenuGroupLabel>{workflow.name} crew</MenuGroupLabel>
          {Object.entries(workflow.bots).map(([role, bot]) => {
            const template =
              bot.template.kind === "template"
                ? templates?.find((item) => item.id === bot.template.id)
                : undefined;
            return (
              <MenuItem key={role} disabled>
                <span className="flex min-w-0 flex-1 justify-between gap-4">
                  <span>{template?.name ?? formatStageName(role)}</span>
                  <span className="text-xs text-muted-foreground">
                    {template?.modelSelection.model ?? "Project bot"}
                  </span>
                </span>
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={props.onEditCrew}>Edit crew…</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
