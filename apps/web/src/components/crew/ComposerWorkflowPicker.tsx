import { formatStageName, workflowSummaryLine } from "@t3tools/client-runtime/crew-stage";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { UsersIcon, WorkflowIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { useProject, useServerConfigs } from "../../state/entities";
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
import { botDefaultWorkflowId, resolveDraftWorkflowId, useCrewDraftStore } from "./crewDraftStore";

const NO_WORKFLOW = "";

/** Whether the environment can run workflows; the picker is hidden elsewhere. */
export function useEnvironmentSupportsWorkflows(environmentId: EnvironmentId | null) {
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  return config?.environment.capabilities.workflows === true;
}

/** The workflow a new thread starts on until one is picked: its project's bot's default. */
function useDefaultWorkflowId(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  enabled: boolean,
): string | null {
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const bots = useEnvironmentQuery(
    enabled && project ? botsEnvironment.list({ environmentId, input: {} }) : null,
  ).data;
  return project && bots ? botDefaultWorkflowId(bots, project) : null;
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
  const defaultWorkflowId = useDefaultWorkflowId(
    input.environmentId,
    input.projectId,
    supported && input.draftId !== null,
  );
  const workflowId = resolveDraftWorkflowId(picked, defaultWorkflowId);
  const definitions = useEnvironmentQuery(
    supported && input.projectId
      ? workflowsEnvironment.definitions({
          environmentId: input.environmentId,
          input: {},
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
 * set in Crew settings.
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
  const roles = useEnvironmentQuery(
    workflow ? rolesEnvironment.roles({ environmentId: props.environmentId, input: {} }) : null,
  ).data;
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
          {Object.entries(workflow.roles).map(([slot, entry]) => {
            const role = roles?.find((item) => item.id === entry.roleId);
            return (
              <MenuItem key={slot} disabled>
                <span className="flex min-w-0 flex-1 justify-between gap-4">
                  <span>{role?.name ?? formatStageName(slot)}</span>
                  <span className="text-xs text-muted-foreground">
                    {role?.modelSelection.model ?? ""}
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
