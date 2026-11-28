// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  botHeadquartersThreadId,
  CommandId,
  type EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  headquartersBotId,
  headquartersProjectId,
  projectHeadquartersThreadId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type Project,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type WorkflowSnapshot,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CrewService } from "../crew/CrewService.ts";
import { OLDER_PEER_LEAD_ROLE_ID, olderPeerLeadRole } from "../crew/olderPeerLead.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FeatureService } from "../features/FeatureService.ts";
import { NoticeInbox } from "../features/NoticeInbox.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  type BotHome,
  type BotProject,
  type BotProjectsResult,
  isManagerHome,
  LinkBotNotices,
  LinkBotProjects,
  LinkBotTask,
  type LibraryCopyRefusal,
  type LibraryCopySet,
  type LinkedNotice,
  type ListedBot,
  type ManagerHome,
  type RequestHome,
} from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { isUnanswered } from "../peer/PeerMcpClient.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
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

/** Who starts work on a linked environment: a bot's headquarters, or a project's manager. */
export type LaunchActor = { readonly botId: string } | { readonly managerProjectId: ProjectId };

/**
 * What a linked environment's headquarters or project manager asks for: a launch, with who asks
 * and its workflow.
 */
export interface LinkedProjectManagerLaunch extends ProjectManagerLaunch {
  readonly home: RequestHome;
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
 * there, as a request in that project.
 */
export class BotReach extends Context.Service<
  BotReach,
  {
    /** This environment's bots, each with its home here and the linked environments it may use. */
    readonly list: Effect.Effect<ReadonlyArray<ListedBot>, OrchestratorMcpFailure>;
    /**
     * The bot's projects here and on every linked environment that answers. From a project's
     * manager with no bot named: its project here and its copies there that it works on.
     */
    readonly projects: (
      scope: Scope,
      botId: string | undefined,
    ) => Effect.Effect<BotProjectsResult, OrchestratorMcpFailure>;
    /**
     * For a linked environment: the projects here its bot (`home`) owns, or the copy here its
     * project's manager works on.
     */
    readonly projectsForLink: (
      home: RequestHome,
    ) => Effect.Effect<ReadonlyArray<BotProject>, OrchestratorMcpFailure>;
    /** Fails, naming why, unless `actor` may start work on linked environment `environmentId`. */
    readonly checkLaunch: (
      environmentId: EnvironmentId,
      actor: LaunchActor,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /**
     * From a bot's headquarters here: starts a request as a task in a project on
     * linked environment `environmentId`, checking the bot may work there first. Fails with
     * `orchestration_error` while that environment can't be reached; the same `clientRequestId`
     * from the same scope never starts a second run there.
     */
    readonly launchProjectManager: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      environmentId: EnvironmentId,
      actor: LaunchActor,
      input: ProjectManagerLaunch,
    ) => Effect.Effect<LaunchedProjectManager, OrchestratorMcpFailure>;
    /** For a linked machine from before imports: refuses its copies, saying why. */
    readonly libraryForLink: (
      scope: McpInvocationContext.McpInvocationScope,
      copy: LibraryCopySet,
    ) => Effect.Effect<
      { readonly refused: ReadonlyArray<LibraryCopyRefusal> },
      OrchestratorMcpFailure
    >;
    /**
     * For a linked environment's project manager: what the requests it started here heard since
     * `since`, oldest first.
     */
    readonly noticesForLink: (
      home: ManagerHome,
      since: string,
    ) => Effect.Effect<ReadonlyArray<LinkedNotice>, OrchestratorMcpFailure>;
    /**
     * Brings each project manager here what its requests on the linked environments it works on
     * heard, such as a feature that stopped to ask the person, once per notice.
     */
    readonly relayManagerNotices: Effect.Effect<void>;
    /** For a linked environment's headquarters: starts the request here, or says why not. */
    readonly startForLink: (
      scope: Scope,
      input: LinkedProjectManagerLaunch,
    ) => Effect.Effect<LaunchedProjectManager, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotReach") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const UNREACHABLE = "which isn't reachable";
/** This side's word that the environment didn't answer, not a failure the other side sent. */
export const isUnreachable = (error: OrchestratorMcpFailure) =>
  isUnanswered(error) ||
  (error.code === "orchestration_error" && error.message.includes(UNREACHABLE));

const unavailable = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);

const branchSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "request";

const managerName = (project: { readonly title: string }) => `${project.title}'s manager`;

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
  const git = yield* GitWorkflowService;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const inbox = yield* NoticeInbox;
  // One request's launch and cancel take turns here.
  const runLocks = yield* KeyedLock.make<string>();
  // Per manager and environment, the newest notice relayed. A restart looks back an hour; each
  // notice is posted once whatever it re-reads.
  const relayedUntil = new Map<string, string>();
  const relayStart = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));

  const here = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  /**
   * The projects here a bot owns: one living here (`botId`), or one elsewhere (`home`); or the
   * copy here of a project whose manager lives elsewhere (a manager's `home`), or that project
   * here itself (`projectId`).
   */
  const ownedHere = Effect.fn("BotReach.ownedHere")(function* (
    owner: { readonly botId: string } | { readonly projectId: ProjectId } | RequestHome,
  ) {
    const { environmentId, label } = yield* here;
    const owns = (project: Project) =>
      "environmentId" in owner
        ? isManagerHome(owner)
          ? project.remoteManager?.environmentId === owner.environmentId &&
            project.remoteManager.projectId === owner.projectId
          : project.remoteBot?.environmentId === owner.environmentId &&
            project.remoteBot.botId === owner.botId
        : "botId" in owner
          ? project.botId === owner.botId
          : project.id === owner.projectId;
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
    // Scratch and bots' homes are where headquarters work, not projects to hand work to.
    const owned = yield* Effect.filter(
      snapshot.projects.flatMap((project) =>
        project.deletedAt === null && owns(project)
          ? [{ ...project, botId: "botId" in owner ? owner.botId : (project.botId ?? "") }]
          : [],
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

  /** Requests on a headquarters or manager thread that wait for a linked environment to answer. */
  const waitingRequests = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["subagents"], {
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
        // A bot or manager that never opened its thread has nothing waiting.
        Effect.orElseSucceed(() => []),
      );

  /** Who asks from here, as a linked environment knows it, with what it owns here. */
  const askerHere = Effect.fn("BotReach.askerHere")(function* (
    scope: Scope,
    requestedBotId: string | undefined,
  ) {
    const self = yield* here;
    const managed =
      requestedBotId === undefined && scope.thread !== undefined
        ? headquartersProjectId(scope.thread.threadId)
        : null;
    if (managed !== null) {
      const project = Option.getOrUndefined(
        yield* projects.getById(managed).pipe(Effect.mapError(unavailable)),
      );
      if (project === undefined || project.deletedAt !== null) {
        return yield* failure("invalid_request", "This manager's project is gone.");
      }
      const home: ManagerHome = {
        environmentId: self.environmentId,
        projectId: project.id,
        name: managerName(project),
        label: self.label,
      };
      return {
        self,
        home,
        actor: { id: project.id, name: home.name },
        local: yield* ownedHere({ projectId: project.id }),
        waiting: yield* waitingRequests(projectHeadquartersThreadId(project.id)),
      };
    }
    const botId =
      requestedBotId ??
      (scope.thread === undefined ? null : headquartersBotId(scope.thread.threadId));
    if (botId === null) {
      return yield* failure(
        "target_required",
        "Pass botId: this thread isn't a bot's headquarters or a project's manager. t3_bot_list shows the bots.",
      );
    }
    const bot = yield* bots.get(botId).pipe(Effect.mapError(unavailable));
    if (bot === null) {
      return yield* failure(
        "invalid_request",
        "The bot was not found; t3_bot_list shows this environment's bots.",
      );
    }
    const home: BotHome = {
      environmentId: self.environmentId,
      botId: bot.id,
      botName: bot.name,
      label: self.label,
    };
    return {
      self,
      home,
      actor: { id: bot.id, name: bot.name },
      local: yield* ownedHere({ botId: bot.id }),
      waiting: yield* waitingRequests(botHeadquartersThreadId(bot.id)),
    };
  });

  const projectsOf: BotReach["Service"]["projects"] = Effect.fn("BotReach.projects")(
    function* (scope, requestedBotId) {
      const { self, home, actor, local, waiting } = yield* askerHere(scope, requestedBotId);
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
        bot: actor,
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
   * revision here, with its enabled crew roles. Nothing when it's gone.
   */
  const workflowSnapshot = Effect.fn("BotReach.workflowSnapshot")(function* (
    modelSelection: ModelSelection,
  ) {
    const workflow = yield* crew
      .getWorkflow(FEATURE_DELIVERY_WORKFLOW_ID)
      .pipe(Effect.mapError(unavailable));
    if (workflow === null) return undefined;
    const roles = yield* Effect.forEach(workflow.crewRoleIds, (id) =>
      crew.getRole(id).pipe(Effect.mapError(unavailable)),
    );
    const snapshot: WorkflowSnapshot = {
      workflow: {
        id: workflow.id,
        name: workflow.name,
        instructions: workflow.instructions,
        leadRoleId: OLDER_PEER_LEAD_ROLE_ID,
        crewRoleIds: workflow.crewRoleIds,
        revision: workflow.revision,
      },
      roles: [
        olderPeerLeadRole(modelSelection),
        ...roles.flatMap((role) =>
          role !== null && role.enabled
            ? [
                {
                  id: role.id,
                  name: role.name,
                  instructions: role.instructions,
                  modelSelection: role.modelSelection,
                  fallbackModelSelection: role.fallbackModelSelection ?? null,
                  // Older peers require it.
                  runtimeMode: "full-access" as const,
                },
              ]
            : [],
        ),
      ],
    };
    return snapshot;
  });

  const linkTo = (environmentId: EnvironmentId) =>
    links.get(environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * Who asks, as the linked environment knows it, and the link's label. Every bot and manager may
   * work on every linked environment; `check` refuses one that isn't linked.
   */
  const asker = Effect.fn("BotReach.asker")(function* (
    environmentId: EnvironmentId,
    actor: LaunchActor,
    check: boolean,
  ) {
    const self = yield* here;
    const link = yield* linkTo(environmentId);
    const label = link?.label ?? environmentId;
    if (check && link === undefined) {
      return yield* failure(
        "invalid_request",
        `${label} isn't linked to this machine, so nothing was started there. The person can link it in Settings → Labs → Linked environments.`,
      );
    }
    if ("botId" in actor) {
      const bot = yield* bots
        .get(actor.botId)
        .pipe(check ? Effect.mapError(unavailable) : Effect.orElseSucceed(() => null));
      if (check && bot === null) {
        return yield* failure("invalid_request", "This headquarters' bot is gone.");
      }
      const home: RequestHome = {
        environmentId: self.environmentId,
        botId: actor.botId,
        botName: bot?.name ?? actor.botId,
        label: self.label,
      };
      return { home, link, label };
    }
    const project = Option.getOrUndefined(
      yield* projects
        .getById(actor.managerProjectId)
        .pipe(check ? Effect.mapError(unavailable) : Effect.orElseSucceed(() => Option.none())),
    );
    if (check && (project === undefined || project.deletedAt !== null)) {
      return yield* failure("invalid_request", "This manager's project is gone.");
    }
    const home: RequestHome = {
      environmentId: self.environmentId,
      projectId: actor.managerProjectId,
      name: project === undefined ? "Project manager" : managerName(project),
      label: self.label,
    };
    return { home, link, label };
  });

  const checkLaunch: BotReach["Service"]["checkLaunch"] = (environmentId, actor) =>
    asker(environmentId, actor, true).pipe(Effect.asVoid);

  const launchProjectManager: BotReach["Service"]["launchProjectManager"] = Effect.fn(
    "BotReach.launchProjectManager",
  )(function* (scope, environmentId, actor, input) {
    const cleanup = input.cancelIfStarted === true;
    // Cleanup goes by the request's own record, whatever became of who asked or its permission.
    const { home, link, label } = yield* asker(environmentId, actor, !cleanup);
    // As the other side would refuse it, before link forwarding's generic runtime-mode refusal.
    if (!cleanup && link !== undefined && link.access !== "full-access") {
      return yield* failure(
        "capability_denied",
        `${label} is linked with ${link.access} access, and a bot's project work there needs full access. Link ${label} again with full access in Settings → Environments → Linked environments.`,
      );
    }
    // Unreachable is the one failure a waiting request retries.
    const unreachable = Effect.gen(function* () {
      const reached = link?.lastReachedAt ?? null;
      return yield* failure(
        "orchestration_error",
        `Project ${input.projectId} is on ${label}, ${UNREACHABLE} (${sinceText(reached, yield* DateTime.now)}). Nothing was started there.`,
      );
    });
    yield* links
      .resolve(environmentId)
      .pipe(Effect.catch((error) => (error.reason === "unreachable" ? unreachable : Effect.void)));
    const workflow = cleanup ? undefined : yield* workflowSnapshot(input.modelSelection);
    const self = yield* here;
    return yield* forwarding
      .call(scope, LinkBotTask, environmentId, {
        ...input,
        home,
        ...(workflow === undefined ? {} : { workflow }),
      })
      .pipe(
        Effect.catchIf(isUnanswered, () => unreachable),
        Effect.catchIf(isOlderPeer, () =>
          failure(
            "invalid_request",
            `Update Bosun on ${label} to give it work from ${self.label}.`,
          ),
        ),
      );
  });

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
      // Keyed by the bot's home, not the link session, so a re-link or a retry after this
      // environment came back mid-launch finds the run the first attempt started.
      const key = hash(`${input.home.environmentId}\n${input.clientRequestId}`).slice(0, 24);
      const runId = `link-task:${key}`;
      // The caller ended the request: a run still queued here never starts; one that started
      // is named for the caller to stop. Honoured over any link access, as stopping work is.
      // A launch and a cancel of one request take turns, so a cancel sees what a launch made.
      if (input.cancelIfStarted === true) {
        return yield* runLocks.withLock(
          runId,
          Effect.gen(function* () {
            const existing = yield* crew.cancelQueuedRun(runId).pipe(Effect.mapError(unavailable));
            if (existing === null || !existing.started) {
              return yield* failure("run_not_found", "Nothing runs here for this request.");
            }
            return {
              threadId: existing.run.threadId,
              runId: null,
              modelSelection: existing.run.modelSelection,
            };
          }),
        );
      }
      // Below full access, project work from a link is fenced and setup scripts are skipped.
      if (client.access !== "full-access") {
        return yield* failure(
          "capability_denied",
          `${self.label} is linked with ${client.access} access, and a bot's project work there needs full access. Link ${self.label} again with full access in Settings → Environments → Linked environments.`,
        );
      }
      return yield* runLocks.withLock(
        runId,
        Effect.gen(function* () {
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
          if (isManagerHome(home)) {
            const placed = project.remoteManager;
            if (
              placed?.environmentId !== home.environmentId ||
              placed.projectId !== home.projectId
            ) {
              return yield* failure(
                "capability_denied",
                `${project.title} on ${self.label} ${placed == null ? "has its own project manager" : `has its manager on ${placed.homeLabel}`}, not ${home.name} from ${home.label}. Set it to live on ${home.label} in Project settings → Project manager first.`,
              );
            }
          }
          const owner = project.remoteBot;
          if (
            !isManagerHome(home) &&
            (owner?.environmentId !== home.environmentId || owner.botId !== home.botId)
          ) {
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
          if (
            !isManagerHome(home) &&
            owner != null &&
            (owner.name !== home.botName || owner.homeLabel !== home.label)
          ) {
            yield* projects
              .assignBot({
                commandId: CommandId.make(`remote-bot-name:${NodeCrypto.randomUUID()}`),
                projectId: project.id,
                botId: null,
                remoteBot: { ...owner, name: home.botName, homeLabel: home.label },
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          // It runs on the model and access sent; a feature it starts follows the sent workflow.
          const carried = { runtimeMode: input.runtimeMode, modelSelection: input.modelSelection };
          // A request this environment refuses as it is stays refused; anything else may pass.
          const refusedOrPassing = (error: { readonly _tag: string; readonly message: string }) =>
            failure(
              error._tag === "CrewValidationError" ? "invalid_request" : "orchestration_error",
              error.message,
            );
          const member = yield* crew
            .ensureLinkedRequestMember(project.id, input.modelSelection)
            .pipe(Effect.mapError(refusedOrPassing));
          // As a request here does: its own worktree, branched from the project's current branch.
          const base = yield* git
            .currentBranch(project.workspaceRoot)
            .pipe(Effect.orElseSucceed(() => null));
          const run = yield* crew
            .createRun({
              id: runId,
              memberId: member.id,
              projectId: project.id,
              taskText: input.task,
              title: input.title,
              carried,
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
            .pipe(Effect.mapError(refusedOrPassing));
          return { threadId: run.threadId, runId: null, modelSelection: run.modelSelection };
        }),
      );
    },
  );

  /** A machine from before imports still pushes its set; it hears why nothing was taken. */
  const libraryForLink: BotReach["Service"]["libraryForLink"] = Effect.fn(
    "BotReach.libraryForLink",
  )(function* (_scope, copy) {
    const self = yield* here;
    const reason = `${self.label} imports workflows and roles instead of taking copies. Update Bosun on ${copy.owner.label}.`;
    return {
      refused: [
        ...copy.workflows.map((item) => ({ kind: "workflow" as const, id: item.id, reason })),
        ...copy.roles.map((item) => ({ kind: "role" as const, id: item.id, reason })),
      ],
    };
  });

  const noticesForLink: BotReach["Service"]["noticesForLink"] = Effect.fn(
    "BotReach.noticesForLink",
  )(function* (home, since) {
    const copies = yield* ownedHere(home);
    return yield* inbox
      .postedToLinkedRequests({ projectIds: copies.map((copy) => copy.projectId), since })
      .pipe(Effect.mapError(unavailable));
  });

  /** How a manager's relay reads its copies there: as its own thread, under its own keys. */
  const relayScope = (
    threadId: ThreadId,
    providerInstanceId: ModelSelection["instanceId"],
    environmentId: EnvironmentId,
  ): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId,
    requestNamespace: `manager-notices:${threadId}`,
    thread: { threadId, providerSessionId: `manager-notices:${threadId}`, providerInstanceId },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const relayManagerNotices: BotReach["Service"]["relayManagerNotices"] = Effect.gen(function* () {
    const reachable = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).filter(
      (link) => link.status === "reachable",
    );
    if (reachable.length === 0) return;
    const self = yield* here;
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
    for (const project of snapshot.projects) {
      if (project.deletedAt !== null || project.remoteManager != null) continue;
      const targets = reachable;
      const threadId = projectHeadquartersThreadId(project.id);
      // A manager that never opened, or is turned off, has no one to tell.
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.archivedAt !== null) continue;
      const home: ManagerHome = {
        environmentId: self.environmentId,
        projectId: project.id,
        name: managerName(project),
        label: self.label,
      };
      for (const link of targets) {
        const cursor = `${project.id}\n${link.environmentId}`;
        const since = relayedUntil.get(cursor) ?? relayStart;
        const scope = relayScope(threadId, shell.modelSelection.instanceId, self.environmentId);
        const notices = yield* forwarding
          .call(scope, LinkBotNotices, link.environmentId, { home, since })
          .pipe(
            Effect.timeout(LINK_LIST_TIMEOUT),
            Effect.map((answered) => answered.notices),
            // An older or unreachable environment is asked again next time.
            Effect.orElseSucceed((): ReadonlyArray<LinkedNotice> => []),
          );
        for (const notice of notices) {
          yield* inbox.post({
            threadId,
            key: `linked-notice:${link.environmentId}:${notice.threadId}:${notice.key}`,
            text: `On ${link.label}, for the request in thread ${notice.threadId} there:\n\n${notice.text}`,
          });
        }
        const newest = notices.at(-1);
        if (newest !== undefined) relayedUntil.set(cursor, newest.createdAt);
      }
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Relaying linked notices failed", { cause })),
    Effect.withSpan("BotReach.relayManagerNotices"),
  );

  const list: BotReach["Service"]["list"] = Effect.gen(function* () {
    const home = yield* here;
    const listed = yield* bots.list.pipe(Effect.mapError(unavailable));
    const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
    return listed.map((bot) => ({
      ...bot,
      runtimeMode: "full-access" as const,
      longConversation: "compact" as const,
      home,
      permittedEnvironments: linked.map((link) => ({
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
    noticesForLink,
    libraryForLink,
    relayManagerNotices,
  });
});

export const layer = Layer.effect(BotReach, make);
