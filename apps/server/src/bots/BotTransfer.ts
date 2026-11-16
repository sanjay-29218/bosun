import {
  botHeadquartersThreadId,
  type BotTransferInput,
  type BotTransferResult,
  CommandId,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type Project,
  type ProjectRemoteBot,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Tool from "effect/ai/Tool";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  type BotHome,
  type BotProject,
  LinkBotImport,
  LinkBotProjects,
  LinkBotRehome,
  type TransferredAutomation,
} from "../mcp/toolkits/bots/linkTools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { isUnanswered } from "../peer/PeerMcpClient.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotService from "./BotService.ts";
import * as BotStore from "./BotStore.ts";

type Scope = McpInvocationContext.McpInvocationScope;
type ImportInput = Tool.Parameters<typeof LinkBotImport>;
type ImportResult = Tool.Success<typeof LinkBotImport>;
type RehomeInput = Tool.Parameters<typeof LinkBotRehome>;

/** One asleep machine is reported instead of holding up the preview. */
const LINK_LIST_TIMEOUT = Duration.seconds(8);

const olderBosunMessage = (label: string) => `Update Bosun on ${label} to copy bots to it.`;
export const webhookReason = (label: string) =>
  `New webhook URL on ${label}. Point the sender at it, set a signing secret on ${label} if the sender signs requests, then turn it on.`;
const copiedReason = (label: string) => `Copied from ${label}. Turn it on when you're ready.`;
const movingReason = (label: string) => `Moving to ${label}`;

/**
 * Copies a bot to a linked environment, or moves it there. Bots stay environment-local, so the
 * copy is a new bot there, made over the link; a move then hands the bot's projects to it and
 * removes the bot here once the copy confirms.
 */
export class BotTransfer extends Context.Service<
  BotTransfer,
  {
    /** For a person here. With `dryRun`, changes nothing and returns what would happen. */
    readonly transfer: (
      input: BotTransferInput,
    ) => Effect.Effect<BotTransferResult, BotService.BotValidationError>;
    /** For a linked environment: takes its bot's copy here, checks it would, or undoes it. */
    readonly importForLink: (
      scope: Scope,
      input: ImportInput,
    ) => Effect.Effect<ImportResult, OrchestratorMcpFailure>;
    /** For a linked environment: gives the projects here its moved bot owned to their new owner. */
    readonly rehomeForLink: (
      scope: Scope,
      input: RehomeInput,
    ) => Effect.Effect<{ readonly moved: number }, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotTransfer") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const unavailable = (error: { readonly message: string }) =>
  failure("orchestration_error", error.message);
const refuse = (reason: string) => new BotService.BotValidationError({ reason });

/** A target from before transfers answers that it has no such tool. */
const isOlderTarget = (error: OrchestratorMcpFailure) =>
  /Tool '?t3_bot_link_(import|rehome)'? not found/.test(error.message);

/** A stored schedule as a save takes it; a webhook keeps no signature, whose secret stays here. */
const upsertSchedule = (schedule: ScheduledTask["schedule"]): ScheduledTaskUpsertSchedule => {
  switch (schedule.type) {
    case "webhook":
      return {
        type: "webhook",
        signature: null,
        ...(schedule.maxDeliveryAgeMinutes === undefined
          ? {}
          : { maxDeliveryAgeMinutes: schedule.maxDeliveryAgeMinutes }),
        ...(schedule.dedupe === undefined ? {} : { dedupe: schedule.dedupe }),
        ...(schedule.filters === undefined ? {} : { filters: schedule.filters }),
      };
    case "interval":
      return { type: "interval", everyMs: Math.max(60_000, schedule.everyMs) };
    default:
      return schedule;
  }
};

const remoteBotOf = (home: BotHome): ProjectRemoteBot => ({
  environmentId: home.environmentId,
  botId: home.botId,
  name: home.botName,
  homeLabel: home.label,
});

const make = Effect.gen(function* () {
  const bots = yield* BotService.BotService;
  const store = yield* BotStore.BotStore;
  const projects = yield* ProjectService.ProjectService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Two transfers of one bot, or two imports of one copy, never interleave.
  const locks = yield* KeyedLock.make<string>();

  const here = environment.getDescriptor.pipe(
    Effect.map((descriptor) => ({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
    })),
  );

  /** The live projects here, Scratch and bots' homes left out, that `owns` picks. */
  const projectsHere = Effect.fn("BotTransfer.projectsHere")(function* (
    owns: (project: Project) => boolean,
  ) {
    const snapshot = yield* projects.snapshot;
    return yield* Effect.filter(
      snapshot.projects.filter((project) => project.deletedAt === null && owns(project)),
      (project) => Effect.map(folders.isHiddenProject(project.id), (hidden) => !hidden),
    );
  });

  /** A person's transfer reaches the target as this environment's link, with no calling thread. */
  const personScope = (environmentId: EnvironmentId, botId: string): Scope => ({
    environmentId,
    requestNamespace: `bot-transfer:${botId}`,
    thread: undefined,
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /** What it takes to change bots here for a linked environment: its link at full access. */
  const requireFullAccessLink = Effect.fn("BotTransfer.requireFullAccessLink")(function* (
    scope: Scope,
  ) {
    const self = yield* here;
    const client = scope.client;
    if (client?.linked !== true) {
      return yield* failure(
        "capability_denied",
        "Only a linked environment copies or moves its bots here this way.",
      );
    }
    // A copied bot can carry full access, so only a full-access link may make one here.
    if (client.access !== "full-access") {
      return yield* failure(
        "capability_denied",
        `${self.label} is linked with ${client.access} access, and a bot copied here needs full access. Link ${self.label} again with full access in Settings → Environments → Linked environments.`,
      );
    }
    return self;
  });

  /** Whether the bot here under `newBotId` is a copy of `from`'s bot. */
  const isCopyOf = (from: BotHome, newBotId: string) =>
    store.copiedFrom(newBotId).pipe(
      Effect.map(
        (origin) => origin?.environmentId === from.environmentId && origin.botId === from.botId,
      ),
      Effect.mapError(unavailable),
    );

  const discardImport = Effect.fn("BotTransfer.discardImport")(function* (
    from: BotHome,
    newBotId: string,
  ) {
    // Only a copy that bot made is undone; a bot here that merely shares the ID is left alone.
    if (!(yield* isCopyOf(from, newBotId))) return false;
    const taken = yield* projectsHere((project) => project.botId === newBotId).pipe(
      Effect.mapError(unavailable),
    );
    yield* Effect.forEach(
      taken,
      (project) =>
        projects
          .assignBot({
            commandId: CommandId.make(`bot-copy-undo:${newBotId}:${project.id}`),
            projectId: project.id,
            botId: null,
            remoteBot: remoteBotOf(from),
          })
          .pipe(Effect.mapError(unavailable)),
      { discard: true },
    );
    // Its ID is free again unless its headquarters opened, whose thread ID can't be made again.
    const opened = yield* threads
      .getThreadShell(botHeadquartersThreadId(newBotId))
      .pipe(Effect.orElseSucceed(() => null));
    yield* bots
      .removeCompletely(newBotId, { forgetId: opened === null })
      .pipe(Effect.mapError(unavailable));
    return true;
  });

  const importForLink: BotTransfer["Service"]["importForLink"] = Effect.fn(
    "BotTransfer.importForLink",
  )(function* (scope, input) {
    const self = yield* requireFullAccessLink(scope);
    const { home: from, newBotId } = input;
    const linkedEnvironmentIds = yield* store.linkedEnvironmentIds.pipe(
      Effect.mapError(unavailable),
    );
    return yield* locks.withLock(
      `import:${newBotId}`,
      Effect.gen(function* () {
        if (input.discard === true) {
          const undone = yield* discardImport(from, newBotId);
          return { botId: newBotId, linkedEnvironmentIds, undone };
        }
        const existing = yield* bots.get(newBotId).pipe(Effect.mapError(unavailable));
        if (existing !== null && !(yield* isCopyOf(from, newBotId))) {
          return yield* failure("invalid_request", `Bot ID ${newBotId} is already in use here.`);
        }
        if (input.dryRun === true) return { botId: newBotId, linkedEnvironmentIds, undone: false };
        // It may work where the original could and on the original's home, as far as links reach.
        const permitted = [...input.bot.permittedEnvironmentIds, from.environmentId].filter((id) =>
          linkedEnvironmentIds.includes(id),
        );
        yield* bots
          .insertCopy({
            bot: { ...input.bot, id: newBotId, permittedEnvironmentIds: permitted },
            copiedFrom: { environmentId: from.environmentId, botId: from.botId },
            homeFiles: input.homeFiles,
          })
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
        const saved = yield* Effect.forEach(input.automations, (automation) =>
          scheduledTasks
            .upsert({
              commandId: CommandId.make(`bot-copy:${newBotId}:${automation.id}`),
              title: automation.title,
              prompt: automation.prompt,
              enabled: false,
              schedule: automation.schedule,
              botId: newBotId,
              ...(automation.threadMode === undefined ? {} : { threadMode: automation.threadMode }),
              workspaceStrategy: automation.workspaceStrategy,
              modelSelection: automation.modelSelection,
              runtimeMode: automation.runtimeMode,
              interactionMode: automation.interactionMode,
            })
            .pipe(
              Effect.map(({ task }) => ({ id: task.id, automation })),
              Effect.mapError((error) => failure("invalid_request", error.message)),
            ),
        );
        const ids = (pick: (automation: TransferredAutomation) => boolean) =>
          saved.flatMap((entry) => (pick(entry.automation) ? [entry.id] : []));
        const isWebhook = (automation: TransferredAutomation) =>
          automation.schedule.type === "webhook";
        yield* scheduledTasks
          .pauseTasks({ taskIds: ids(isWebhook), reason: webhookReason(self.label) })
          .pipe(Effect.mapError(unavailable));
        if (input.mode === "copy") {
          yield* scheduledTasks
            .pauseTasks({
              taskIds: ids((automation) => !isWebhook(automation)),
              reason: copiedReason(from.label),
            })
            .pipe(Effect.mapError(unavailable));
          return { botId: newBotId, linkedEnvironmentIds, undone: false };
        }
        // The move confirms here: the copy takes its projects here and its automations run.
        const owned = yield* projectsHere(
          (project) =>
            project.remoteBot?.environmentId === from.environmentId &&
            project.remoteBot.botId === from.botId,
        ).pipe(Effect.mapError(unavailable));
        yield* Effect.forEach(
          owned,
          (project) =>
            projects
              .assignBot({
                commandId: CommandId.make(`bot-move-in:${newBotId}:${project.id}`),
                projectId: project.id,
                botId: newBotId,
              })
              .pipe(Effect.mapError(unavailable)),
          { discard: true },
        );
        yield* scheduledTasks.resumeTasks(
          ids((automation) => automation.enabled && !isWebhook(automation)),
        );
        return { botId: newBotId, linkedEnvironmentIds, undone: false };
      }),
    );
  });

  const rehomeForLink: BotTransfer["Service"]["rehomeForLink"] = Effect.fn(
    "BotTransfer.rehomeForLink",
  )(function* (scope, { from, to }) {
    const self = yield* requireFullAccessLink(scope);
    const owned = yield* projectsHere(
      (project) =>
        project.remoteBot?.environmentId === from.environmentId &&
        project.remoteBot.botId === from.botId,
    ).pipe(Effect.mapError(unavailable));
    yield* Effect.forEach(
      owned,
      (project) =>
        projects
          .assignBot({
            commandId: CommandId.make(
              `bot-rehome:${from.environmentId}:${from.botId}:${to?.botId ?? "none"}:${project.id}`,
            ),
            projectId: project.id,
            ...(to === null
              ? { botId: null }
              : to.environmentId === self.environmentId
                ? { botId: to.botId }
                : { botId: null, remoteBot: remoteBotOf(to) }),
          })
          .pipe(Effect.mapError(unavailable)),
      { discard: true },
    );
    return { moved: owned.length };
  });

  /** Whether any thread in the bot's home, its headquarters among them, has a turn running. */
  const isWorking = Effect.fn("BotTransfer.isWorking")(function* (
    botId: string,
    homePath: string | null | undefined,
  ) {
    const home =
      homePath == null
        ? Option.none<Project>()
        : yield* projects.getByWorkspaceRoot(homePath).pipe(Effect.orElseSucceed(Option.none));
    const shells = Option.isNone(home)
      ? []
      : (yield* threads
          .getShellSnapshot({ projectId: home.value.id })
          .pipe(Effect.orElseSucceed(() => ({ threads: [] })))).threads;
    const headquarters = yield* threads
      .getThreadShell(botHeadquartersThreadId(botId))
      .pipe(Effect.orElseSucceed(() => null));
    return [...shells, ...(headquarters === null ? [] : [headquarters])].some(
      (shell) => shell.activeRunId != null,
    );
  });

  /** Everything a transfer needs, checked without changing anything. */
  const prepare = Effect.fn("BotTransfer.prepare")(function* (input: BotTransferInput) {
    const self = yield* here;
    const target = input.targetEnvironmentId;
    if (!(yield* links.enabled)) {
      return yield* refuse(
        `Linked environments are off on ${self.label}. Turn them on in Settings → Labs.`,
      );
    }
    const bot = yield* bots
      .get(input.botId)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    if (bot === null) return yield* refuse("Bot not found");
    if (target === self.environmentId) {
      return yield* refuse(`${bot.name} already lives on ${self.label}.`);
    }
    const link = Option.getOrUndefined(
      yield* links.get(target).pipe(Effect.mapError((error) => refuse(error.message))),
    );
    if (link === undefined) {
      return yield* refuse(
        `${self.label} isn't linked to that machine. Link it in Settings → Environments → Linked environments.`,
      );
    }
    const label = link.label;
    if (link.access !== "full-access") {
      return yield* refuse(
        `${label} is linked with ${link.access} access, and copying a bot there needs full access. Link ${label} again with full access in Settings → Environments → Linked environments.`,
      );
    }
    const unchanged = `${bot.name} is still on ${self.label}, unchanged.`;
    const callFailure = (error: OrchestratorMcpFailure) =>
      isOlderTarget(error)
        ? olderBosunMessage(label)
        : isUnanswered(error)
          ? `${label} didn't answer. ${unchanged}`
          : error.message;
    const resolved = yield* links
      .resolve(target)
      .pipe(
        Effect.mapError((error) =>
          refuse(
            error.reason === "unreachable" ? `${label} didn't answer. ${unchanged}` : error.message,
          ),
        ),
      );
    if (resolved.capabilities.botTransfer !== true) return yield* refuse(olderBosunMessage(label));
    // A move that hasn't finished keeps its target and ID, so a retry from anywhere finishes it.
    const pending =
      input.mode === "move"
        ? yield* store.pendingMove(bot.id).pipe(Effect.mapError((error) => refuse(error.message)))
        : null;
    if (pending !== null && pending.targetEnvironmentId !== target) {
      const pendingLabel = Option.match(
        yield* links.get(pending.targetEnvironmentId).pipe(Effect.orElseSucceed(Option.none)),
        { onNone: () => "the other machine", onSome: (other) => other.label },
      );
      return yield* refuse(
        `${bot.name}'s move to ${pendingLabel} hasn't finished. Move it to ${pendingLabel} again to finish it first.`,
      );
    }
    const newBotId = pending?.newBotId ?? input.newBotId;
    if (input.mode === "move" && (yield* isWorking(bot.id, bot.homePath))) {
      return yield* refuse(`${bot.name} is working. Wait for it or stop it, then move.`);
    }
    const homeFiles = yield* bots
      .homeFiles(bot.id)
      .pipe(Effect.mapError((error) => refuse(error.message)));
    const moving = movingReason(label);
    const tasks = (yield* scheduledTasks
      .list()
      .pipe(Effect.mapError((error) => refuse(error.message)))).tasks.filter(
      (task) => task.botId === bot.id,
    );
    const automations = tasks.map((task): TransferredAutomation => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      // A retry counts the ones an earlier attempt paused as on.
      enabled: task.enabled || task.pausedReason === moving,
      schedule: upsertSchedule(task.schedule),
      ...(task.threadMode === undefined ? {} : { threadMode: task.threadMode }),
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
    }));
    const home: BotHome = {
      environmentId: self.environmentId,
      botId: bot.id,
      botName: bot.name,
      label: self.label,
    };
    const scope = personScope(self.environmentId, bot.id);
    const importInput = (extra: Partial<ImportInput>): ImportInput => ({
      home,
      newBotId,
      mode: input.mode,
      bot: {
        name: bot.name,
        avatar: bot.avatar,
        color: bot.color,
        instructions: bot.instructions,
        withheldTools: bot.withheldTools,
        runtimeMode: bot.runtimeMode,
        modelSelection: bot.modelSelection,
        longConversation: bot.longConversation,
        permittedEnvironmentIds: bot.permittedEnvironmentIds,
      },
      homeFiles,
      automations,
      ...extra,
    });
    const callImport = (extra: Partial<ImportInput>) =>
      forwarding.call(scope, LinkBotImport, target, importInput(extra));
    const checked = yield* callImport({ homeFiles: [], dryRun: true }).pipe(
      Effect.mapError((error) => refuse(callFailure(error))),
    );
    const targetLinks = checked.linkedEnvironmentIds;

    const local = (yield* projectsHere((project) => project.botId === bot.id).pipe(
      Effect.mapError((error) => refuse(error.message)),
    )).map((project) => ({
      environmentId: self.environmentId,
      environmentLabel: self.label,
      projectId: project.id,
      title: project.title,
    }));
    const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
    const elsewhere = yield* Effect.forEach(
      linked,
      (entry) =>
        (entry.status === "reachable"
          ? forwarding.call(scope, LinkBotProjects, entry.environmentId, { home }).pipe(
              Effect.timeout(LINK_LIST_TIMEOUT),
              Effect.map((answered) => answered.projects),
              Effect.option,
            )
          : Effect.succeedNone
        ).pipe(Effect.map((answered) => ({ link: entry, answered }))),
      { concurrency: "unbounded" },
    );
    const remote = elsewhere.flatMap(({ answered }) =>
      Option.getOrElse(answered, (): ReadonlyArray<BotProject> => []),
    );
    const outcome = (environmentId: EnvironmentId) =>
      input.mode === "copy"
        ? ("stays-with-original" as const)
        : environmentId === target || targetLinks.includes(environmentId)
          ? ("comes-along" as const)
          : ("left-without-bot" as const);
    const isWebhook = (automation: TransferredAutomation) => automation.schedule.type === "webhook";
    const result: BotTransferResult = {
      bot: { environmentId: target, id: newBotId, name: bot.name },
      projects: [...local, ...remote].map((project) => ({
        environmentId: project.environmentId,
        environmentLabel: project.environmentLabel,
        projectId: project.projectId,
        title: project.title,
        outcome: outcome(project.environmentId),
      })),
      unchecked: elsewhere.flatMap(({ link: entry, answered }) =>
        Option.isNone(answered) ? [{ environmentId: entry.environmentId, label: entry.label }] : [],
      ),
      automations: {
        copied: automations.length,
        enabled: automations.filter((automation) => automation.enabled && !isWebhook(automation))
          .length,
        needAttention: automations
          .filter(isWebhook)
          .map((automation) => ({ title: automation.title, reason: webhookReason(label) })),
      },
      warnings: [],
    };
    return {
      self,
      bot,
      home,
      label,
      scope,
      target,
      targetLinks,
      tasks,
      moving,
      result,
      callImport,
      callFailure,
      // Machines other than this one and the target where projects may still name the bot.
      others: elsewhere.filter(({ link: entry }) => entry.environmentId !== target),
    };
  });

  type Prepared = Effect.Success<ReturnType<typeof prepare>>;

  const copy = Effect.fn("BotTransfer.copy")(function* (prepared: Prepared) {
    const imported = yield* Effect.result(prepared.callImport({}));
    if (Result.isFailure(imported)) {
      // Whatever the target applied before failing is undone, when it answers.
      yield* prepared.callImport({ homeFiles: [], discard: true }).pipe(Effect.ignore);
      return yield* refuse(prepared.callFailure(imported.failure));
    }
    return prepared.result;
  });

  const move = Effect.fn("BotTransfer.move")(function* (prepared: Prepared) {
    const { bot, label, self, target, targetLinks } = prepared;
    const newBotId = prepared.result.bot.id;
    const settle = (move: BotStore.PendingMove | null) =>
      store.setPendingMove(bot.id, move).pipe(Effect.mapError((error) => refuse(error.message)));
    // Recorded first, so until the move finishes or is undone every retry goes to this target.
    yield* settle({ targetEnvironmentId: target, newBotId });
    // Automations never run in two places: they stop here before the copy can start them there.
    const paused = yield* scheduledTasks
      .pauseForBot({ botId: bot.id, reason: prepared.moving })
      .pipe(Effect.mapError((error) => refuse(error.message)));
    const pausedIds: ReadonlyArray<ScheduledTaskId> = [
      ...paused,
      ...prepared.tasks
        .filter((task) => !task.enabled && task.pausedReason === prepared.moving)
        .map((task) => task.id),
    ];
    // Nothing is left on the target, so the move is over and the automations run here again.
    const resume = settle(null).pipe(Effect.andThen(scheduledTasks.resumeTasks(pausedIds)));
    const imported = yield* Effect.result(prepared.callImport({}));
    if (Result.isFailure(imported)) {
      const error = imported.failure;
      if (isOlderTarget(error)) {
        yield* resume;
        return yield* refuse(olderBosunMessage(label));
      }
      const discarded = yield* Effect.result(prepared.callImport({ homeFiles: [], discard: true }));
      if (Result.isFailure(discarded)) {
        return yield* refuse(
          `Couldn't confirm with ${label}. ${bot.name}'s automations stay paused here, because ${label} may already run them; don't turn them on here. Move ${bot.name} to ${label} again to finish.`,
        );
      }
      yield* resume;
      return yield* refuse(prepared.callFailure(error));
    }

    const newHome: BotHome = {
      environmentId: target,
      botId: newBotId,
      botName: bot.name,
      label,
    };
    const local = yield* projectsHere((project) => project.botId === bot.id).pipe(
      Effect.mapError((error) => refuse(error.message)),
    );
    const handedOver = targetLinks.includes(self.environmentId);
    yield* Effect.forEach(
      local,
      (project) =>
        projects
          .assignBot({
            commandId: CommandId.make(`bot-move-out:${newHome.botId}:${project.id}`),
            projectId: project.id,
            botId: null,
            ...(handedOver ? { remoteBot: remoteBotOf(newHome) } : {}),
          })
          .pipe(
            Effect.mapError((error) =>
              refuse(
                `Moved ${bot.name} to ${label}, but couldn't hand over ${project.title}: ${error.message} Try again.`,
              ),
            ),
          ),
      { discard: true },
    );
    const warnings: Array<string> = [];
    for (const { link, answered } of prepared.others) {
      const known = Option.getOrElse(answered, (): ReadonlyArray<BotProject> => []);
      if (Option.isSome(answered) && known.length === 0) continue;
      const rehomed = yield* Effect.result(
        forwarding.call(prepared.scope, LinkBotRehome, link.environmentId, {
          from: prepared.home,
          to: targetLinks.includes(link.environmentId) ? newHome : null,
        }),
      );
      if (Result.isFailure(rehomed)) {
        warnings.push(
          known.length === 0
            ? `Couldn't reach ${link.label}. Its projects may still name ${bot.name} on ${self.label}; add them again when ${link.label} is back.`
            : `Couldn't reach ${link.label}. Its ${known.length === 1 ? "project still names" : `${known.length} projects still name`} ${bot.name} on ${self.label}; add them again when ${link.label} is back.`,
        );
      }
    }
    yield* bots
      .removeCompletely(bot.id)
      .pipe(
        Effect.mapError((error) =>
          refuse(
            `Moved ${bot.name} to ${label}, but couldn't remove it from ${self.label}: ${error.message} Try again.`,
          ),
        ),
      );
    return { ...prepared.result, warnings };
  });

  const transfer: BotTransfer["Service"]["transfer"] = Effect.fn("BotTransfer.transfer")(
    function* (input) {
      return yield* locks.withLock(
        `transfer:${input.botId}`,
        Effect.gen(function* () {
          const prepared = yield* prepare(input);
          if (input.dryRun === true) return prepared.result;
          return yield* input.mode === "copy" ? copy(prepared) : move(prepared);
        }),
      );
    },
  );

  return BotTransfer.of({ transfer, importForLink, rehomeForLink });
});

export const layer = Layer.effect(BotTransfer, make);
