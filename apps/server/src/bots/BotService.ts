import {
  CAPTAIN_BOT_ID,
  CommandId,
  DEFAULT_BOT_TOOLS,
  type Bot,
  type BotAvatar,
  type BotCreateInput,
  type BotUpdateInput,
  type Project,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CrewService } from "../crew/CrewService.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import * as BotStore from "./BotStore.ts";

export class BotValidationError extends Schema.TaggedError<BotValidationError>()(
  "BotValidationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type BotServiceError = BotValidationError | PersistenceSqlError;

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Bot>, BotServiceError>;
    readonly get: (id: string) => Effect.Effect<Bot | null, BotServiceError>;
    /** Adds a bot at the end of the rail. Repeating the same create returns the same bot. */
    readonly create: (input: BotCreateInput) => Effect.Effect<Bot, BotServiceError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<Bot, BotServiceError>;
    /**
     * Refused for Captain and for a bot that still owns a project; move its projects first.
     * Deletes the automations that run as the bot. Runs the bot already started keep
     * working, but it gets no new ones.
     */
    readonly delete: (id: string) => Effect.Effect<void, BotServiceError>;
    /** Sets the rail order; `botIds` lists every bot exactly once. */
    readonly reorder: (
      botIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Bot>, BotServiceError>;
    /** Gives a project to another bot. Runs already started keep the bot that started them. */
    readonly moveProject: (input: {
      readonly projectId: ProjectId;
      readonly botId: string;
    }) => Effect.Effect<Project, BotServiceError | ProjectService.ProjectServiceError>;
  }
>()("t3/bots/BotService") {}

const text = (value: string, field: string, max: number) => {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max
    ? Effect.succeed(trimmed)
    : Effect.fail(new BotValidationError({ reason: `${field} must contain 1-${max} characters` }));
};
const tools = (value: ReadonlyArray<string>) =>
  value.length <= 32 && value.every((tool) => tool.trim().length > 0 && tool.length <= 100)
    ? Effect.succeed([...new Set(value.map((tool) => tool.trim()))])
    : Effect.fail(new BotValidationError({ reason: "Invalid tool grants" }));

const DEFAULT_INSTRUCTIONS =
  "Coordinate the person's requests for your projects. Hand project work to a project with t3_feature_start and a stable feature ID; its result comes back to this thread. Relay it clearly, and never claim work is done before it reports.";

const sameAvatar = (left: BotAvatar, right: BotAvatar) =>
  left.head === right.head &&
  left.eyes === right.eyes &&
  left.face === right.face &&
  left.top === right.top &&
  left.cheeks === right.cheeks &&
  left.smile === right.smile;

const sameCreate = (bot: Bot, input: BotCreateInput) =>
  bot.name === input.name.trim() &&
  sameAvatar(bot.avatar, input.avatar) &&
  bot.color === input.color;

const make = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  const projects = yield* ProjectService.ProjectService;
  const workflows = yield* WorkflowStore;
  const crypto = yield* Crypto.Crypto;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  // Optional so bot tests run without the crew; the server always provides it.
  const crew = yield* Effect.serviceOption(CrewService);

  const requireWorkflow = (id: string | null | undefined) =>
    id === null || id === undefined
      ? Effect.void
      : workflows
          .getLatestDefinition(id)
          .pipe(
            Effect.flatMap((definition) =>
              definition
                ? Effect.void
                : Effect.fail(
                    new BotValidationError({ reason: "Default workflow does not exist" }),
                  ),
            ),
          );

  const requireBot = (id: string) =>
    store
      .get(id)
      .pipe(
        Effect.filterOrFail(
          Predicate.isNotNull,
          () => new BotValidationError({ reason: "Bot not found" }),
        ),
      );

  return BotService.of({
    list: store.list,
    get: store.get,
    create: Effect.fn("BotService.create")(function* (input) {
      const id = yield* text(input.id, "Bot ID", 128);
      const existing = yield* store.get(id);
      if (existing) {
        if (sameCreate(existing, input)) return existing;
        return yield* new BotValidationError({ reason: "Bot ID belongs to another bot" });
      }
      yield* requireWorkflow(input.defaultWorkflowId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const all = yield* store.list;
      const bot: Bot = {
        id,
        name: yield* text(input.name, "Bot name", 80),
        avatar: input.avatar,
        color: input.color,
        instructions: yield* text(
          input.instructions ?? DEFAULT_INSTRUCTIONS,
          "Bot instructions",
          16_000,
        ),
        allowedTools: yield* tools(input.allowedTools ?? DEFAULT_BOT_TOOLS),
        runtimeMode: input.runtimeMode ?? "approval-required",
        modelSelection: input.modelSelection ?? null,
        defaultWorkflowId: input.defaultWorkflowId ?? null,
        longConversation: input.longConversation ?? "compact",
        position: all.reduce((max, other) => Math.max(max, other.position + 1), 0),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (yield* store.insert(bot)) return bot;
      // A concurrent create with the same ID won, or a crew member already has the ID.
      const winner = yield* store.get(id);
      if (winner && sameCreate(winner, input)) return winner;
      return yield* new BotValidationError({ reason: "Bot ID is already in use" });
    }),
    update: Effect.fn("BotService.update")(function* (input) {
      const previous = yield* requireBot(input.id);
      if (previous.revision !== input.expectedRevision) {
        return yield* new BotValidationError({ reason: "Bot changed; reload and retry" });
      }
      if (input.defaultWorkflowId !== undefined) yield* requireWorkflow(input.defaultWorkflowId);
      const next: Bot = {
        ...previous,
        ...(input.name === undefined ? {} : { name: yield* text(input.name, "Bot name", 80) }),
        ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.instructions === undefined
          ? {}
          : { instructions: yield* text(input.instructions, "Bot instructions", 16_000) }),
        ...(input.allowedTools === undefined
          ? {}
          : { allowedTools: yield* tools(input.allowedTools) }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.defaultWorkflowId === undefined
          ? {}
          : { defaultWorkflowId: input.defaultWorkflowId }),
        ...(input.longConversation === undefined
          ? {}
          : { longConversation: input.longConversation }),
        revision: previous.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (!(yield* store.update(next, previous.revision))) {
        return yield* new BotValidationError({ reason: "Bot changed; reload and retry" });
      }
      // An open headquarters takes the new runtime mode and model on its next turn.
      if (Option.isSome(crew)) {
        yield* crew.value
          .syncHeadquarters(next.id)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Headquarters settings sync failed", { botId: next.id, error }),
            ),
          );
      }
      return next;
    }),
    delete: Effect.fn("BotService.delete")(function* (id) {
      if (id === CAPTAIN_BOT_ID) {
        return yield* new BotValidationError({ reason: "Captain can't be deleted" });
      }
      const deletedAt = DateTime.formatIso(yield* DateTime.now);
      const result = yield* store.withOwnership(store.deleteUnlessOwning(id, deletedAt));
      if (result === "owns-projects") {
        return yield* new BotValidationError({
          reason: "Move this bot's projects to another bot before deleting it",
        });
      }
      if (result === "missing") {
        return yield* new BotValidationError({ reason: "Bot not found" });
      }
      // Saving a bot task checks the bot in the same write, so none can land after this.
      yield* scheduledTasks.deleteForBot(id).pipe(
        Effect.mapError(
          () =>
            new BotValidationError({
              reason: "Deleted the bot, but not its automations; delete them in Automations",
            }),
        ),
      );
    }),
    reorder: Effect.fn("BotService.reorder")(function* (botIds) {
      const all = yield* store.list;
      const ids = new Set(botIds);
      if (
        ids.size !== botIds.length ||
        ids.size !== all.length ||
        all.some((bot) => !ids.has(bot.id))
      ) {
        return yield* new BotValidationError({
          reason: "Reorder must list every bot exactly once",
        });
      }
      yield* store.setPositions(botIds, DateTime.formatIso(yield* DateTime.now));
      return yield* store.list;
    }),
    moveProject: Effect.fn("BotService.moveProject")(function* ({ projectId, botId }) {
      yield* requireBot(botId);
      const commandId = CommandId.make(
        `bot-move:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      );
      return yield* projects.assignBot({ commandId, projectId, botId });
    }),
  });
});

export const layer = Layer.effect(BotService, make);
