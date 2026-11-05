// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CAPTAIN_BOT_ID,
  type EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  headquartersBotId,
  isProviderAvailable,
  logicalBotKey,
  type ModelSelection,
  OrchestratorMcpFailure,
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
  type BotProject,
  type BotProjectsResult,
  LinkBotProjects,
  LinkBotTask,
} from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { LINKED_ENVIRONMENT_STOPPED_ANSWERING } from "../peer/PeerMcpClient.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
}

/** What a linked environment's headquarters asks for: a launch, with its bot and workflow. */
export interface LinkedProjectManagerLaunch extends ProjectManagerLaunch {
  readonly botKey: string;
  readonly botName: string;
  readonly workflow?: WorkflowSnapshot | undefined;
}

export interface LaunchedProjectManager {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly modelSelection: ModelSelection;
}

/**
 * A bot's reach beyond its own environment. Bots stay environment-local; the same bot on a
 * linked environment is the one with the same `logicalBotKey`, and work for its projects there
 * runs there, as that project's manager.
 */
export class BotReach extends Context.Service<
  BotReach,
  {
    /** The bot's projects here and on every linked environment that answers. */
    readonly projects: (
      scope: Scope,
      botId: string | undefined,
    ) => Effect.Effect<BotProjectsResult, OrchestratorMcpFailure>;
    /** For a linked environment: the projects here its bot (`botKey`) owns. */
    readonly projectsForLink: (
      botKey: string,
    ) => Effect.Effect<ReadonlyArray<BotProject>, OrchestratorMcpFailure>;
    /**
     * From a bot's headquarters here: starts a request as a task of the Feature manager of a project on
     * linked environment `environmentId`. Fails before anything starts when it can't run there.
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

  const here = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  const ownedHere = Effect.fn("BotReach.ownedHere")(function* (botKey: string) {
    const { environmentId, label } = yield* here;
    const listed = yield* bots.list.pipe(Effect.mapError(unavailable));
    const owners = new Set(
      listed.filter((bot) => logicalBotKey(bot) === botKey).map((bot) => bot.id),
    );
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
    const owned = snapshot.projects.filter(
      (project) => project.deletedAt === null && owners.has(project.botId ?? CAPTAIN_BOT_ID),
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
          botId: project.botId ?? CAPTAIN_BOT_ID,
          openFeatures: records
            .filter((feature) => feature.status === "open")
            .map((feature) => ({ featureId: feature.id, title: feature.title })),
        })),
      ),
    );
  });

  const projectsForLink: BotReach["Service"]["projectsForLink"] = (botKey) => ownedHere(botKey);

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
      const botKey = logicalBotKey(bot);
      const self = yield* here;
      const local = yield* ownedHere(botKey);
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
          return forwarding.call(scope, LinkBotProjects, link.environmentId, { botKey }).pipe(
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
                environment: entry(false, error.message),
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
                allowedTools: role.allowedTools,
                modelSelection: role.modelSelection,
                runtimeMode: role.runtimeMode,
              },
            ]
          : [],
      ),
    };
    return snapshot;
  });

  const launchProjectManager: BotReach["Service"]["launchProjectManager"] = Effect.fn(
    "BotReach.launchProjectManager",
  )(function* (scope, environmentId, botId, input) {
    const bot = yield* bots.get(botId).pipe(Effect.mapError(unavailable));
    if (bot === null) return yield* failure("invalid_request", "This headquarters' bot is gone.");
    const link = Option.getOrUndefined(
      yield* links.get(environmentId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const label = link?.label ?? environmentId;
    // Nothing is queued: the person decides whether to wait for it or not.
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
    const workflow = yield* workflowSnapshot();
    return yield* forwarding
      .call(scope, LinkBotTask, environmentId, {
        ...input,
        botKey: logicalBotKey(bot),
        botName: bot.name,
        ...(workflow === undefined ? {} : { workflow }),
      })
      .pipe(
        Effect.catchIf(
          (error) => error.message === LINKED_ENVIRONMENT_STOPPED_ANSWERING,
          () => unreachable,
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
      const project = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
      );
      if (project === undefined || project.deletedAt !== null) {
        return yield* failure(
          "invalid_request",
          `No project ${input.projectId} on ${self.label}. t3_bot_projects lists the bot's projects there.`,
        );
      }
      const owner = yield* bots
        .get(project.botId ?? CAPTAIN_BOT_ID)
        .pipe(Effect.mapError(unavailable));
      if (owner === null || logicalBotKey(owner) !== input.botKey) {
        return yield* failure(
          "capability_denied",
          `${project.title} on ${self.label} belongs to ${owner?.name ?? "another bot"}, not ${input.botName}. Give it to ${input.botName} there first (Bots → ${input.botName} → Projects).`,
        );
      }
      if (!(yield* modelAvailable(input.modelSelection))) {
        return yield* failure(
          "invalid_request",
          `${input.botName}'s task there runs on ${input.modelSelection.model} (${input.modelSelection.instanceId}), which isn't available on ${self.label}. Sign it in there, or change ${input.botName}'s model.`,
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
      const key = hash(`${client.sessionId}\n${input.clientRequestId}`).slice(0, 24);
      // As a request here does: its own worktree, branched from the project's current branch.
      const base = yield* git
        .currentBranch(project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => null));
      const run = yield* crew
        .createRun({
          id: `link-task:${key}`,
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
        .pipe(Effect.mapError(unavailable));
      return { threadId: run.threadId, runId: null, modelSelection: run.modelSelection };
    },
  );

  return BotReach.of({
    projects: projectsOf,
    projectsForLink,
    launchProjectManager,
    startForLink,
  });
});

export const layer = Layer.effect(BotReach, make);
