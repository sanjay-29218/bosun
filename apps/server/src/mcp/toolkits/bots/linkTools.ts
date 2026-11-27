import {
  Bot,
  BotTransferMode,
  EnvironmentId,
  LibraryItemKind,
  ModelSelection,
  NodeId,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  SnapshotRole,
  ScheduledTaskThreadMode,
  ScheduledTaskUpsertSchedule,
  ThreadId,
  WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** One project a bot owns, on the environment that names it. */
export const BotProject = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  botId: Schema.String,
  openFeatures: Schema.Array(Schema.Struct({ featureId: Schema.String, title: Schema.String })),
});
export type BotProject = typeof BotProject.Type;

export const BotProjectsResult = Schema.Struct({
  bot: Schema.Struct({ id: Schema.String, name: Schema.String }),
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      here: Schema.Boolean,
      reachable: Schema.Boolean,
      lastReachedAt: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      waiting: Schema.Array(
        Schema.Struct({ taskId: NodeId, projectId: ProjectId, title: Schema.String }),
      ).annotate({
        description: "This bot's requests that wait for the environment to answer, then start.",
      }),
    }),
  ),
  projects: Schema.Array(BotProject),
});
export type BotProjectsResult = typeof BotProjectsResult.Type;

const EnvironmentName = { environmentId: EnvironmentId, label: Schema.String };

/** A bot with where it lives and the linked environments it may start work on. */
export const ListedBot = Schema.Struct({
  ...Bot.fields,
  /** Older linked environments require these. Every bot runs with full access and compacts. */
  runtimeMode: Schema.optionalKey(RuntimeMode),
  longConversation: Schema.optionalKey(Schema.Literals(["compact", "new-session"])),
  home: Schema.Struct(EnvironmentName).annotate({
    description: "The environment the bot lives on: its settings, chat, memory and home folder.",
  }),
  permittedEnvironments: Schema.Array(
    Schema.Struct({ ...EnvironmentName, reachable: Schema.Boolean }),
  ).annotate({
    description:
      "Every environment linked to the bot's home, each of which it works on; reachable says whether the link answered last time.",
  }),
});
export type ListedBot = typeof ListedBot.Type;

/** The calling environment's bot, as it names itself; it owns projects here by `remoteBot`. */
export const BotHome = Schema.Struct({
  environmentId: EnvironmentId,
  botId: Schema.String,
  botName: Schema.String,
  label: Schema.String,
});
export type BotHome = typeof BotHome.Type;

/**
 * The calling environment's project manager, by its project there; it works on that project's
 * copy here when the copy's `remoteManager` names it.
 */
export const ManagerHome = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  name: Schema.String,
  label: Schema.String,
});
export type ManagerHome = typeof ManagerHome.Type;

/** Who on the calling environment asks: a bot, or a project's manager. */
export const RequestHome = Schema.Union([BotHome, ManagerHome]);
export type RequestHome = typeof RequestHome.Type;
export const isManagerHome = (home: RequestHome): home is ManagerHome => "projectId" in home;

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

/**
 * Tools only a linked environment calls, for its bot's work here. Agents never see them:
 * `crewToolGrants.ts` lists them to link sessions alone.
 */
export const LinkBotProjects = Tool.make("t3_bot_link_projects", {
  ...shared,
  description:
    "The projects here owned by the calling environment's bot, or the copy here its project's manager works on (`home`), with their open features.",
  parameters: Schema.Struct({ home: RequestHome }),
  success: Schema.Struct({ projects: Schema.Array(BotProject) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LinkBotTask = Tool.make("t3_bot_link_task", {
  ...shared,
  description:
    "Starts a request from the calling environment's bot headquarters or project manager as a task in this project, in a new worktree.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    home: RequestHome,
    task: Schema.String,
    title: Schema.String,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    clientRequestId: Schema.String,
    /** The workflow a feature for this request runs on, by value. */
    workflow: Schema.optional(WorkflowSnapshot),
    /**
     * Starts nothing: cancels the run an earlier call with this key left queued, and returns its
     * thread if it started; fails `run_not_found` when none runs.
     */
    cancelIfStarted: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, false);

/** A notice the calling environment's project manager hears from its project's copy here. */
export const LinkedNotice = Schema.Struct({
  threadId: ThreadId,
  key: Schema.String,
  text: Schema.String,
  failed: Schema.Boolean,
  createdAt: Schema.String,
});
export type LinkedNotice = typeof LinkedNotice.Type;

export const LinkBotNotices = Tool.make("t3_bot_link_notices", {
  ...shared,
  description:
    "What the requests the calling environment's project manager (`home`) started here heard since `since`: their features' reports and questions for the person.",
  parameters: Schema.Struct({ home: ManagerHome, since: Schema.String }),
  success: Schema.Struct({ notices: Schema.Array(LinkedNotice) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

/** The machine that called, as it names itself; a link session doesn't say. */
const LibraryOwner = Schema.Struct({ environmentId: EnvironmentId, label: Schema.String });

/** What machines from before imports send: every workflow and role they made, as one set. */
export const LibraryCopySet = Schema.Struct({
  owner: LibraryOwner,
  workflows: Schema.Array(WorkflowSnapshot.fields.workflow),
  roles: Schema.Array(Schema.Struct({ ...SnapshotRole.fields, enabled: Schema.Boolean })),
});
export type LibraryCopySet = typeof LibraryCopySet.Type;

export const LibraryCopyRefusal = Schema.Struct({
  kind: LibraryItemKind,
  id: Schema.String,
  reason: Schema.String,
});
export type LibraryCopyRefusal = typeof LibraryCopyRefusal.Type;

/** Kept so older machines hear why their copies stopped: this machine imports instead. */
export const LinkLibrary = Tool.make("t3_crew_link_library", {
  ...shared,
  description: "Refuses every workflow and role: this environment imports them instead.",
  parameters: LibraryCopySet,
  success: Schema.Struct({ refused: Schema.Array(LibraryCopyRefusal) }),
})
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false);

/** A workflow or role as it travels to a machine that imports it. */
export const LibraryItemContent = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  /** Roles only. */
  modelSelection: Schema.optionalKey(ModelSelection),
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Workflows only. */
  crewRoleIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type LibraryItemContent = typeof LibraryItemContent.Type;

const LibraryItemRef = { kind: LibraryItemKind, id: Schema.String };

export const LibrarySyncInput = Schema.Struct({
  importer: LibraryOwner,
  /** Every workflow and role the caller holds from here: the whole set, replacing the last. */
  holds: Schema.Array(
    Schema.Struct({
      ...LibraryItemRef,
      revision: Schema.NullOr(Schema.Int),
      edited: Schema.Boolean,
    }),
  ),
  /** Also lists every workflow and role here that the caller could import, with content. */
  list: Schema.optionalKey(Schema.Boolean),
});
export type LibrarySyncInput = typeof LibrarySyncInput.Type;

export const LibrarySyncResult = Schema.Struct({
  label: Schema.String,
  /** Each held one here at its revision; content when the caller needs it. */
  items: Schema.Array(
    Schema.Struct({
      ...LibraryItemRef,
      revision: Schema.Int,
      content: Schema.optionalKey(LibraryItemContent),
      /** Listed only: where this one was imported from, when it was. */
      importedFrom: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  /** Saves here the person sent to the caller: take them unless the caller edited since. */
  push: Schema.Array(
    Schema.Struct({ ...LibraryItemRef, revision: Schema.Int, overwrites: Schema.Boolean }),
  ),
  /** Held ones this machine no longer has. */
  missing: Schema.Array(Schema.Struct(LibraryItemRef)),
});
export type LibrarySyncResult = typeof LibrarySyncResult.Type;

export const LinkLibrarySync = Tool.make("t3_crew_link_library_sync", {
  ...shared,
  description:
    "Reports the workflows and roles the calling environment imported from here, and returns their revisions here, updates the person sent it, and, with `list`, everything it could import.",
  parameters: LibrarySyncInput,
  success: LibrarySyncResult,
})
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false);

/** An automation that runs as a bot, as its copy on another machine needs it. */
export const TransferredAutomation = Schema.Struct({
  /** Its ID where it came from, so a repeated copy saves the same automation again. */
  id: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  /** Whether it was on where it came from; only a move turns it on again there. */
  enabled: Schema.Boolean,
  /** A webhook's signing secret never travels; its copy has a new URL and no signature check. */
  schedule: ScheduledTaskUpsertSchedule,
  threadMode: Schema.optional(ScheduledTaskThreadMode),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type TransferredAutomation = typeof TransferredAutomation.Type;

/** A bot's settings as its copy on another machine gets them. */
export const TransferredBot = Schema.Struct({
  name: Bot.fields.name,
  avatar: Bot.fields.avatar,
  color: Bot.fields.color,
  instructions: Bot.fields.instructions,
  modelSelection: Bot.fields.modelSelection,
});
export type TransferredBot = typeof TransferredBot.Type;

export const LinkBotImport = Tool.make("t3_bot_link_import", {
  ...shared,
  description:
    "Makes a copy here of the calling environment's bot (`home`) as `newBotId`, with its home folder files and automations, turned off. A move also takes the projects here that bot owned and turns on the automations that were on. Repeating it returns the same copy. `dryRun` changes nothing; `discard` undoes a copy with that `newBotId` from that bot.",
  parameters: Schema.Struct({
    home: BotHome,
    newBotId: Schema.String,
    mode: BotTransferMode,
    bot: TransferredBot,
    homeFiles: Schema.Array(Schema.Struct({ path: Schema.String, contentBase64: Schema.String })),
    automations: Schema.Array(TransferredAutomation),
    dryRun: Schema.optional(Schema.Boolean),
    discard: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    botId: Schema.String,
    /** The environments this one links to, whose projects can stay with the copy. */
    linkedEnvironmentIds: Schema.Array(EnvironmentId),
    /** For `discard`: whether there was a copy to undo. */
    undone: Schema.Boolean,
    /** Whether a copy of `home`'s bot is here under `newBotId` once the call is done. */
    copyExists: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  }),
}).annotate(Tool.Destructive, false);

export const LinkBotRehome = Tool.make("t3_bot_link_rehome", {
  ...shared,
  description:
    "Gives the projects here owned by the calling environment's bot (`from`) to `to`, a bot on a linked environment, or to no bot when it's null, as when that bot moved to another machine.",
  parameters: Schema.Struct({ from: BotHome, to: Schema.NullOr(BotHome) }),
  success: Schema.Struct({ moved: Schema.Int }),
}).annotate(Tool.Destructive, false);
