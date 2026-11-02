import { orderWorkflowStages } from "@t3tools/client-runtime/state/library";
import { formatStageName } from "@t3tools/client-runtime/crew-stage";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CAPTAIN_BOT_ID,
  type EnvironmentId,
  type ProjectId,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { LayersIcon, MessageSquareIcon, StarIcon, UsersIcon, WorkflowIcon } from "lucide-react";

import { useAtomValue } from "@effect/atom-react";

import type { DraftId } from "../../composerDraftStore";
import { useAtomCommand } from "../../state/use-atom-command";
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
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
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

/** The bot that owns a new thread's project; its default workflow is the draft's default. */
function useProjectBot(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  enabled: boolean,
) {
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const bots = useEnvironmentQuery(
    enabled && project ? botsEnvironment.list({ environmentId, input: {} }) : null,
  ).data;
  if (!project || !bots) return { bot: null, defaultWorkflowId: null };
  const botId = project.botId ?? CAPTAIN_BOT_ID;
  return {
    bot: bots.find((bot) => bot.id === botId) ?? null,
    defaultWorkflowId: botDefaultWorkflowId(bots, project),
  };
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
  const { bot, defaultWorkflowId } = useProjectBot(
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
    bot,
    defaultWorkflowId,
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
  const { definitions, workflow, bot, defaultWorkflowId } = useDraftWorkflow(props);
  const setWorkflow = useCrewDraftStore((state) => state.setWorkflow);
  const canEditBot = useAtomValue(botsEnvironment.update.permissionAtom(props.environmentId));
  const updateBot = useAtomCommand(botsEnvironment.update);
  // The bot's default is what New feature and every new thread of its projects start on.
  const makeDefault =
    bot && workflow && workflow.id !== defaultWorkflowId && canEditBot
      ? {
          label: `Make default for ${bot.name}`,
          run: () =>
            void updateBot({
              environmentId: props.environmentId,
              input: { id: bot.id, expectedRevision: bot.revision, defaultWorkflowId: workflow.id },
            }),
        }
      : null;
  return (
    <WorkflowMenu
      definitions={definitions}
      workflow={workflow}
      size={props.size}
      allowNoWorkflow
      makeDefault={makeDefault}
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
  readonly makeDefault: { readonly label: string; readonly run: () => void } | null;
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
        {props.makeDefault ? (
          <MenuItem onClick={props.makeDefault.run}>
            <StarIcon />
            {props.makeDefault.label}
          </MenuItem>
        ) : null}
        <MenuItem onClick={props.onManageWorkflows}>
          <LayersIcon />
          Manage workflows…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Stands in for the model picker while a workflow is picked: every role brings its own model,
 * set in the Library.
 */
export function ComposerCrewControl(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly draftId: DraftId;
  readonly size: ComposerControlSize;
  readonly onEditCrew: () => void;
}) {
  const { workflow } = useDraftWorkflow(props);
  if (!workflow) return null;
  return (
    <CrewMenu
      environmentId={props.environmentId}
      workflow={workflow}
      size={props.size}
      onEditCrew={props.onEditCrew}
    />
  );
}

/** The Crew control: the workflow's roles and their models, read-only. */
function CrewMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowDefinition;
  readonly size: ComposerControlSize;
  readonly onEditCrew: () => void;
}) {
  const menuProps = useComposerMenuProps();
  const { workflow } = props;
  const roles = useEnvironmentQuery(
    rolesEnvironment.roles({ environmentId: props.environmentId, input: {} }),
  ).data;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl size={props.size} aria-label="Crew" />}>
        <ComposerControlIcon icon={UsersIcon} size={props.size} />
        <span data-composer-control-label>Crew</span>
        <span className="text-muted-foreground tabular-nums">
          {Object.keys(workflow.roles).length}
        </span>
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
