import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, WorkflowDefinition } from "@t3tools/contracts";
import { LayersIcon, MessageSquareIcon, UsersIcon, WorkflowIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { botsEnvironment } from "../../state/bots";
import { rolesEnvironment } from "../../state/roles";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "../../state/workflows";
import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  botDefaultWorkflowId,
  resolveDraftWorkflowId,
  unpickedDraftWorkflowId,
  useCrewDraftStore,
} from "./crewDraftStore";

const NO_WORKFLOW = "";

/** Whether the environment can run workflows; the picker is hidden elsewhere. */
export function useEnvironmentSupportsWorkflows(environmentId: EnvironmentId | null) {
  const config = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  return config?.environment.capabilities.workflows === true;
}

/** The default workflow of the bot that owns a new thread's project. */
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
  const featureDraft = useCrewDraftStore((state) =>
    input.draftId ? state.featureDraftIds[input.draftId] === true : false,
  );
  const defaultWorkflowId = useDefaultWorkflowId(
    input.environmentId,
    input.projectId,
    supported && input.draftId !== null,
  );
  const definitions = useEnvironmentQuery(
    supported && input.projectId
      ? workflowsEnvironment.definitions({
          environmentId: input.environmentId,
          input: {},
        })
      : null,
  ).data;
  const workflowId = resolveDraftWorkflowId(
    picked,
    unpickedDraftWorkflowId({
      featureDraft,
      botDefault: defaultWorkflowId,
      firstWorkflow: definitions?.[0]?.id ?? null,
    }),
  );
  return {
    supported: supported && input.projectId !== null && input.draftId !== null,
    definitions: definitions ?? [],
    workflow: definitions?.find((definition) => definition.id === workflowId) ?? null,
    /** False while the draft follows its bot's default workflow. */
    picked: picked !== undefined,
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
  const { definitions, workflow } = useDraftWorkflow(props);
  const roles = useEnvironmentQuery(
    workflow ? rolesEnvironment.roles({ environmentId: props.environmentId, input: {} }) : null,
  ).data;
  const setWorkflow = useCrewDraftStore((state) => state.setWorkflow);
  return (
    <WorkflowMenu
      definitions={definitions}
      workflow={workflow}
      size={props.size}
      allowNoWorkflow
      crew={
        workflow
          ? Object.entries(workflow.roles).map(([slot, entry]) => {
              const role = roles?.find((item) => item.id === entry.roleId);
              return {
                slot,
                name: role?.name ?? formatStageName(slot),
                model: role?.modelSelection.model ?? "",
              };
            })
          : []
      }
      onPick={(workflowId) => setWorkflow(props.draftId, workflowId)}
      onManageWorkflows={props.onManageWorkflows}
    />
  );
}

function WorkflowMenu(props: {
  readonly definitions: ReadonlyArray<WorkflowDefinition>;
  readonly workflow: WorkflowDefinition | null;
  readonly size: ComposerControlSize;
  readonly allowNoWorkflow?: boolean;
  /** The picked workflow's roles and their models: each role brings its own. */
  readonly crew: ReadonlyArray<{
    readonly slot: string;
    readonly name: string;
    readonly model: string;
  }>;
  readonly onPick: (workflowId: string | null) => void;
  readonly onManageWorkflows: () => void;
}) {
  const menuProps = useComposerMenuProps();
  const { workflow } = props;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={props.size}
                  aria-label={workflow ? `Workflow: ${workflow.name}` : "Workflow"}
                  className={workflow ? "bg-accent text-foreground" : undefined}
                />
              }
              data-chat-composer-workflow-picker="true"
            />
          }
        >
          <ComposerControlIcon icon={WorkflowIcon} size={props.size} />
          {workflow ? (
            <span data-composer-control-label className="max-w-40 truncate">
              {workflow.name}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {workflow ? "Change workflow" : "Start a feature with a workflow"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup {...menuProps} side="top" align="start" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Workflow</MenuGroupLabel>
          <MenuRadioGroup
            value={workflow?.id ?? NO_WORKFLOW}
            onValueChange={(value: string) => props.onPick(value === NO_WORKFLOW ? null : value)}
          >
            {props.allowNoWorkflow ? (
              <MenuRadioItem value={NO_WORKFLOW} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">No workflow</span>
                </span>
              </MenuRadioItem>
            ) : null}
            {props.definitions.map((definition) => {
              const stages = orderWorkflowStages(definition).length;
              return (
                <MenuRadioItem key={definition.id} value={definition.id} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{definition.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {stages} {stages === 1 ? "stage" : "stages"}
                    </span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        {props.crew.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <UsersIcon />
              <MenuItemLabel>Crew</MenuItemLabel>
              <span className="text-xs text-muted-foreground tabular-nums">
                {props.crew.length}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              {props.crew.map((member) => (
                <MenuItem key={member.slot} disabled>
                  <span className="flex min-w-0 flex-1 justify-between gap-4">
                    <span>{member.name}</span>
                    <span className="text-xs text-muted-foreground">{member.model}</span>
                  </span>
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuItem onClick={props.onManageWorkflows}>
          <LayersIcon />
          Manage workflows and crews…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
