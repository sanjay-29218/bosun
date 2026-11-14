// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  botHeadquartersThreadId,
  CommandId,
  type EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  headquartersBotId,
  isProviderAvailable,
  type ModelSelection,
  OrchestratorMcpFailure,
  type Project,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type WorkflowSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CrewService } from "../crew/CrewService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FeatureService } from "../features/FeatureService.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  type BotHome,
  type BotProject,
  type BotProjectsResult,
  LinkBotProjects,
  LinkBotTask,
  type ListedBot,
} from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { LINKED_ENVIRONMENT_STOPPED_ANSWERING } from "../peer/PeerMcpClient.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { notPermitted } from "./BotEnvironmentGuard.ts";
import * as BotService from "./BotService.ts";

type Scope = McpInvocationContext.McpInvocationScope;

/** One asleep machine shows as unreachable instead of holding up the whole list. */
const LINK_LIST_TIMEOUT = Duration.seconds(8);

export interface ProjectManagerLaunch {
  readonly projectId: ProjectId;
  readonly task: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly clientRequestId: string;
  /**
   * Starts nothing: cancels the run an earlier attempt with this key left queued there, and
   * returns its thread if it started, for the caller to stop; `run_not_found` when none runs.
   * Needs neither the bot nor its permission, so cleanup works after either is gone.
   */
  readonly cancelIfStarted?: boolean | undefined;
}

/** What a linked environment's headquarters asks for: a launch, with its bot and workflow. */
export interface LinkedProjectManagerLaunch extends ProjectManagerLaunch {
  readonly home: BotHome;
  readonly workflow?: WorkflowSnapshot | undefined;
}

export interface LaunchedProjectManager {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly modelSelection: ModelSelection;
}

/**
 * A bot's reach beyond its own environment. Bots stay environment-local; a project on a linked
 * environment is the bot's when its `remoteBot` names the bot and its home, and work for it runs
 * there, as that project's Feature manager.
 */
export class BotReach extends Context.Service<
  BotReach,
  {
    /** This environment's bots, each with its home here and the linked environments it may use. */
    readonly list: Effect.Effect<ReadonlyArray<ListedBot>, OrchestratorMcpFailure>;
    /** The bot's projects here and on every linked environment that answers. */
    readonly projects: (
      scope: Scope,
      botId: string | undefined,
    ) => Effect.Effect<BotProjectsResult, OrchestratorMcpFailure>;
    /** For a linked environment: the projects here its bot (`home`) owns. */
    readonly projectsForLink: (
      home: BotHome,
    ) => Effect.Effect<ReadonlyArray<BotProject>, OrchestratorMcpFailure>;
    /** Fails, naming why, unless the bot may start work on linked environment `environmentId`. */
    readonly checkLaunch: (
      environmentId: EnvironmentId,
      botId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /**
     * From a bot's headquarters here: starts a request as a task of the Feature manager of a project on
     * linked environment `environmentId`, checking the bot may work there first. Fails with
     * `orchestration_error` while that environment can't be reached; the same `clientRequestId`
     * from the same scope never starts a second run there.
     */
    readonly launchProjectManager: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      environmentId: EnvironmentId,
      botId: string,
      input: ProjectManagerLaunch,
    ) => Effect.Effect<LaunchedProjectManager, OrchestratorMcpFailure>;
    /** For a linked environment's headquarters: starts the request here, or says why not. */
    readonly startForLink: (
      scope: Scope,
      input: LinkedProjectManagerLaunch,
    ) => Effect.Effect<LaunchedProjectManager, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotReach") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const unavailable = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);

const branchSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "request";

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** An environment on a Bosun from before `home` refuses the input with the field it missed. */
const isOlderPeer = (error: OrchestratorMcpFailure) =>
  error.code === "invalid_request" && error.message.includes("botKey");

const sinceText = (lastReachedAt: DateTime.Utc | null, now: DateTime.Utc) => {
  if (lastReachedAt === null) return "never reached";
  const minutes = Math.round(
    (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(lastReachedAt)) / 60_000,
  );
  if (minutes < 1) return "last reached just now";
  if (minutes < 60) return `last reached ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? `last reached ${hours} h ago`
    : `last reached ${Math.round(hours / 24)} days ago`;
};

const make = Effect.gen(function* () {
  const bots = yield* BotService.BotService;
  const projects = yield* ProjectService.ProjectService;
  const features = yield* FeatureService;
  const crew = yield* CrewService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const git = yield* GitWorkflowService;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const here = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  /** The projects here a bot owns: one living here (`botId`), or one elsewhere (`home`). */
  const ownedHere = Effect.fn("BotReach.ownedHere")(function* (
    owner: { readonly botId: string } | BotHome,
  ) {
    const { environmentId, label } = yield* here;
    const owns = (project: Project) =>
      "environmentId" in owner
        ? project.remoteBot?.environmentId === owner.environmentId &&
          project.remoteBot.botId === owner.botId
        : project.botId === owner.botId;
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
    // Scratch and bots' homes are where headquarters work, not projects to hand work to.
    const owned = yield* Effect.filter(
      snapshot.projects.flatMap((project) =>
        project.deletedAt === null && owns(project) ? [{ ...project, botId: owner.botId }] : [],
      ),
      (project) => Effect.map(folders.isHiddenProject(project.id), (hidden) => !hidden),
    );
    return yield* Effect.forEach(owned, (project) =>
      features.listByProject(project.id).pipe(
        Effect.mapError(unavailable),
        Effect.map((records): BotProject => ({
          environmentId,
          environmentLabel: label,
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          botId: project.botId,
          openFeatures: records
            .filter((feature) => feature.status === "open")
            .map((feature) => ({ featureId: feature.id, title: feature.title })),
        })),
      ),
    );
  });

  const projectsForLink: BotReach["Service"]["projectsForLink"] = (home) => ownedHere(home);

  /** The bot's requests on its headquarters that wait for a linked environment to answer. */
  const waitingRequests = (botId: string) =>
    threads
      .getThreadRecords(botHeadquartersThreadId(botId), ["subagents"], {
        omitSettledSubagents: true,
      })
      .pipe(
        Effect.map(({ subagents }) =>
          subagents.flatMap((task) =>
            task.pendingRemote !== undefined &&
            task.remoteChild === undefined &&
            task.result === null
              ? [{ environmentId: task.pendingRemote.environmentId, task }]
              : [],
          ),
        ),
        // A bot that never opened its headquarters has nothing waiting.
        Effect.orElseSucceed(() => []),
      );

  const projectsOf: BotReach["Service"]["projects"] = Effect.fn("BotReach.projects")(
    function* (scope, requestedBotId) {
      const botId =
        requestedBotId ??
        (scope.thread === undefined ? null : headquartersBotId(scope.thread.threadId));
      if (botId === null) {
        return yield* failure(
          "target_required",
          "Pass botId: this thread isn't a bot's headquarters. t3_bot_list shows the bots.",
        );
      }
      const bot = yield* bots.get(botId).pipe(Effect.mapError(unavailable));
      if (bot === null) {
        return yield* failure(
          "invalid_request",
          "The bot was not found; t3_bot_list shows this environment's bots.",
        );
      }
      const self = yield* here;
      const home: BotHome = {
        environmentId: self.environmentId,
        botId: bot.id,
        botName: bot.name,
        label: self.label,
      };
      const local = yield* ownedHere({ botId: bot.id });
      const waiting = yield* waitingRequests(bot.id);
      const waitingFor = (environmentId: EnvironmentId) =>
        waiting.flatMap((entry) =>
          entry.environmentId === environmentId && entry.task.pendingRemote !== undefined
            ? [
                {
                  taskId: entry.task.id,
                  projectId: entry.task.pendingRemote.projectId,
                  title: entry.task.pendingRemote.title,
                },
              ]
            : [],
        );
      // Work a link started never reaches further links, and with the beta off there are none.
      const reachesLinks = scope.client?.linked !== true && scope.linkedEnvironments !== false;
      const linked = reachesLinks ? yield* links.list.pipe(Effect.orElseSucceed(() => [])) : [];
      const now = yield* DateTime.now;
      const remote = yield* Effect.forEach(
        linked,
        (link) => {
          const entry = (reachable: boolean, lastError: string | null) => ({
            environmentId: link.environmentId,
            label: link.label,
            here: false,
            reachable,
            lastReachedAt:
              link.lastReachedAt === null ? null : DateTime.formatIso(link.lastReachedAt),
            lastError,
            waiting: waitingFor(link.environmentId),
          });
          if (link.status !== "reachable") {
            return Effect.succeed({
              environment: entry(
                false,
                link.status === "expired"
                  ? "The link expired; link it again in Settings → Environments → Linked environments."
                  : (link.lastError ?? `Not reachable (${sinceText(link.lastReachedAt, now)}).`),
              ),
              projects: [] as ReadonlyArray<BotProject>,
            });
          }
          return forwarding.call(scope, LinkBotProjects, link.environmentId, { home }).pipe(
            Effect.timeoutOrElse({
              duration: LINK_LIST_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  failure(
                    "orchestration_error",
                    `Didn't answer within ${Duration.toSeconds(LINK_LIST_TIMEOUT)} s.`,
                  ),
                ),
            }),
            Effect.match({
              onFailure: (error) => ({
                environment: entry(
                  false,
                  isOlderPeer(error)
                    ? `Update Bosun on ${link.label} to give it work from ${self.label}.`
                    : error.message,
                ),
                projects: [] as ReadonlyArray<BotProject>,
              }),
              onSuccess: (answered) => ({
                environment: entry(true, null),
                projects: answered.projects,
              }),
            }),
          );
        },
        { concurrency: "unbounded" },
      );
      return {
        bot: { id: bot.id, name: bot.name },
        environments: [
          {
            environmentId: self.environmentId,
            label: self.label,
            here: true,
            reachable: true,
            lastReachedAt: null,
            lastError: null,
            waiting: [],
          },
          ...remote.map(({ environment }) => environment),
        ],
        projects: [...local, ...remote.flatMap(({ projects }) => projects)],
      };
    },
  );

  /**
   * The workflow a feature for a request runs on, sent by value: Feature delivery at its
   * revision here, with its lead and enabled crew roles. Nothing when it's gone.
   */
  const workflowSnapshot = Effect.fn("BotReach.workflowSnapshot")(function* () {
    const workflow = yield* crew
      .getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID)
      .pipe(Effect.mapError(unavailable));
    if (workflow === null) return undefined;
    const roles = yield* Effect.forEach([workflow.leadRoleId, ...workflow.crewRoleIds], (id) =>
      crew.getRole(id).pipe(Effect.mapError(unavailable)),
    );
    const snapshot: WorkflowSnapshot = {
      workflow: {
        id: workflow.id,
        name: workflow.name,
        instructions: workflow.instructions,
        leadRoleId: workflow.leadRoleId,
        crewRoleIds: workflow.crewRoleIds,
        revision: workflow.revision,
      },
      roles: roles.flatMap((role) =>
        role !== null && (role.enabled || role.id === workflow.leadRoleId)
          ? [
              {
                id: role.id,
                name: role.name,
                instructions: role.instructions,
                withheldTools: role.withheldTools,
                modelSelection: role.modelSelection,
                runtimeMode: role.runtimeMode,
              },
            ]
          : [],
      ),
    };
    return snapshot;
  });

  /** The bot and the link's label, failing unless the bot may start work there. */
  const permitted = Effect.fn("BotReach.permitted")(function* (
    environmentId: EnvironmentId,
    botId: string,
  ) {
    const bot = yield* bots.get(botId).pipe(Effect.mapError(unavailable));
    if (bot === null) return yield* failure("invalid_request", "This headquarters' bot is gone.");
    const link = Option.getOrUndefined(
      yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const label = link?.label ?? environmentId;
    if (!bot.permittedEnvironmentIds.includes(environmentId)) {
      return yield* notPermitted(bot.name, label);
    }
    return { bot, link, label };
  });

  const checkLaunch: BotReach["Service"]["checkLaunch"] = (environmentId, botId) =>
    permitted(environmentId, botId).pipe(Effect.asVoid);

  const launchProjectManager: BotReach["Service"]["launchProjectManager"] = Effect.fn(
    "BotReach.launchProjectManager",
  )(function* (scope, environmentId, botId, input) {
    const cleanup = input.cancelIfStarted === true;
    // Cleanup goes by the request's own record, whatever became of the bot or its permission.
    const { bot, link, label } = cleanup
      ? yield* Effect.gen(function* () {
          const found = Option.getOrUndefined(
            yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none())),
          );
          return {
            bot: yield* bots.get(botId).pipe(Effect.orElseSucceed(() => null)),
            link: found,
            label: found?.label ?? environmentId,
          };
        })
      : yield* permitted(environmentId, botId);
    // Unreachable is the one failure a waiting request retries.
    const unreachable = Effect.gen(function* () {
      const reached = link?.lastReachedAt ?? null;
      return yield* failure(
        "orchestration_error",
        `Project ${input.projectId} is on ${label}, which isn't reachable (${sinceText(reached, yield* DateTime.now)}). Nothing was started there.`,
      );
    });
    yield* links
      .resolve(environmentId)
      .pipe(Effect.catch((error) => (error.reason === "unreachable" ? unreachable : Effect.void)));
    const workflow = cleanup ? undefined : yield* workflowSnapshot();
    const self = yield* here;
    return yield* forwarding
      .call(scope, LinkBotTask, environmentId, {
        ...input,
        home: {
          environmentId: self.environmentId,
          botId,
          botName: bot?.name ?? botId,
          label: self.label,
        },
        ...(workflow === undefined ? {} : { workflow }),
      })
      .pipe(
        Effect.catchIf(
          (error) => error.message === LINKED_ENVIRONMENT_STOPPED_ANSWERING,
          () => unreachable,
        ),
        Effect.catchIf(isOlderPeer, () =>
          failure(
            "invalid_request",
            `Update Bosun on ${label} to give it work from ${self.label}.`,
          ),
        ),
      );
  });

  const modelAvailable = (selection: ModelSelection) =>
    providers.getProviders.pipe(
      Effect.map((listed) => {
        const provider = listed.find((candidate) => candidate.instanceId === selection.instanceId);
        return (
          provider !== undefined &&
          provider.enabled &&
          provider.installed &&
          isProviderAvailable(provider) &&
          provider.auth.status !== "unauthenticated" &&
          provider.models.some((model) => model.slug === selection.model)
        );
      }),
    );

  const startForLink: BotReach["Service"]["startForLink"] = Effect.fn("BotReach.startForLink")(
    function* (scope, input) {
      const self = yield* here;
      const client = scope.client;
      if (client?.linked !== true) {
        return yield* failure(
          "capability_denied",
          "Only a linked environment's bot hands work here this way.",
        );
      }
      // Below full access, project work from a link is fenced and setup scripts are skipped.
      if (client.access !== "full-access") {
        return yield* failure(
          "capability_denied",
          `${self.label} is linked with ${client.access} access, and a bot's project work there needs full access. Link ${self.label} again with full access in Settings → Environments → Linked environments.`,
        );
      }
      // Keyed by the bot's home, not the link session, so a re-link or a retry after this
      // environment came back mid-launch finds the run the first attempt started.
      const key = hash(`${input.home.environmentId}\n${input.clientRequestId}`).slice(0, 24);
      const runId = `link-task:${key}`;
      // The caller ended the request: a run still queued here never starts; one that started
      // is named for the caller to stop.
      if (input.cancelIfStarted === true) {
        const existing = yield* crew.cancelQueuedRun(runId).pipe(Effect.mapError(unavailable));
        if (existing === null || !existing.started) {
          return yield* failure("run_not_found", "Nothing runs here for this request.");
        }
        return {
          threadId: existing.run.threadId,
          runId: null,
          modelSelection: existing.run.modelSelection,
        };
      }
      const project = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
      );
      if (
        project === undefined ||
        project.deletedAt !== null ||
        (yield* folders.isHiddenProject(project.id))
      ) {
        return yield* failure(
          "invalid_request",
          `No project ${input.projectId} on ${self.label}. t3_bot_projects lists the bot's projects there.`,
        );
      }
      const { home } = input;
      const owner = project.remoteBot;
      if (owner?.environmentId !== home.environmentId || owner.botId !== home.botId) {
        const local =
          project.botId == null
            ? null
            : yield* bots.get(project.botId).pipe(Effect.mapError(unavailable));
        const holder =
          owner != null
            ? `${owner.name} on ${owner.homeLabel}`
            : project.botId == null
              ? null
              : `${local?.name ?? "another bot"} on ${self.label}`;
        const giveIt = `Give it to ${home.botName} there first (Bots → ${home.botName} → Projects).`;
        return yield* failure(
          "capability_denied",
          holder === null
            ? `${project.title} on ${self.label} has no bot. ${giveIt}`
            : `${project.title} on ${self.label} belongs to ${holder}, not ${home.botName} from ${home.label}. ${giveIt}`,
        );
      }
      // The owner shows here under the name its home last sent.
      if (owner.name !== home.botName || owner.homeLabel !== home.label) {
        yield* projects
          .assignBot({
            commandId: CommandId.make(`remote-bot-name:${NodeCrypto.randomUUID()}`),
            projectId: project.id,
            botId: null,
            remoteBot: { ...owner, name: home.botName, homeLabel: home.label },
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      if (!(yield* modelAvailable(input.modelSelection))) {
        return yield* failure(
          "invalid_request",
          `${home.botName}'s task there runs on ${input.modelSelection.model} (${input.modelSelection.instanceId}), which isn't available on ${self.label}. Sign it in there, or change ${home.botName}'s model.`,
        );
      }
      // Builds before withheld tools sent roles' tools with the opposite meaning.
      if (input.workflow?.roles.some((role) => role.allowedTools !== undefined)) {
        return yield* failure(
          "invalid_request",
          "This Bosun is newer than the environment that sent this; update it to share roles.",
        );
      }
      // Its features run on these roles, so each must be able to run here too.
      for (const role of input.workflow?.roles ?? []) {
        if (!(yield* modelAvailable(role.modelSelection))) {
          return yield* failure(
            "invalid_request",
            `${input.workflow!.workflow.name}'s ${role.name} runs on ${role.modelSelection.model} (${role.modelSelection.instanceId}), which isn't available on ${self.label}. Sign it in there, or change the role's model.`,
          );
        }
      }
      const manager = yield* crew
        .ensureFeatureManager(project.id)
        .pipe(Effect.mapError(unavailable));
      // As a request here does: its own worktree, branched from the project's current branch.
      const base = yield* git
        .currentBranch(project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => null));
      const run = yield* crew
        .createRun({
          id: runId,
          memberId: manager.id,
          projectId: project.id,
          taskText: input.task,
          title: input.title,
          carried: { runtimeMode: input.runtimeMode, modelSelection: input.modelSelection },
          ...(input.workflow === undefined
            ? {}
            : { workflow: { snapshot: input.workflow, here: self.label, from: client.label } }),
          ...(base === null
            ? {}
            : {
                workspace: {
                  branch: `bosun/${branchSlug(input.title)}-${key.slice(0, 6)}`,
                  baseRef: base,
                },
              }),
        })
        .pipe(
          // A request this environment refuses as it is stays refused; anything else may pass.
          Effect.mapError((error) =>
            failure(
              error._tag === "CrewValidationError" ? "invalid_request" : "orchestration_error",
              error.message,
            ),
          ),
        );
      return { threadId: run.threadId, runId: null, modelSelection: run.modelSelection };
    },
  );

  const list: BotReach["Service"]["list"] = Effect.gen(function* () {
    const home = yield* here;
    const listed = yield* bots.list.pipe(Effect.mapError(unavailable));
    const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
    return listed.map((bot) => ({
      ...bot,
      home,
      permittedEnvironments: linked
        .filter((link) => bot.permittedEnvironmentIds.includes(link.environmentId))
        .map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          reachable: link.status === "reachable",
        })),
    }));
  }).pipe(Effect.withSpan("BotReach.list"));

  return BotReach.of({
    list,
    projects: projectsOf,
    projectsForLink,
    checkLaunch,
    launchProjectManager,
    startForLink,
  });
});

export const layer = Layer.effect(BotReach, make);
