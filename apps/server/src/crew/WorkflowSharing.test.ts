import { it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  type WorkflowShareSetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as BotStore from "../bots/BotStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FeatureService } from "../features/FeatureService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { LinkWorkflowSync } from "../mcp/toolkits/bots/linkTools.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CrewService, CrewServiceLive } from "./CrewService.ts";
import { CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntime } from "./CrewThreadRuntime.ts";
import { WorkflowSharing, layer as WorkflowSharingLive } from "./WorkflowSharing.ts";

// The laptop owns a workflow and shares it with the box. Each has its own real crew database;
// the link between them is the box's real receiving side, reached through the tool's schema.

const laptop = { environmentId: EnvironmentId.make("environment-laptop"), label: "Laptop" };
const box = { environmentId: EnvironmentId.make("environment-box"), label: "Box" };
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const WORKFLOW_ID = "workflow:social-media";
const projectId = ProjectId.make("project:blog");

const quietRuntime = Layer.succeed(CrewThreadRuntime, {
  projectExists: () => Effect.succeed(true),
  projectRemoteManager: () => Effect.succeed(null),
  projectBotId: () => Effect.succeed(null),
  projectModelSelection: () => Effect.succeed(null),
  archive: () => Effect.void,
  isHiddenProject: () => Effect.succeed(false),
  botHome: () => Effect.die("unused"),
  moveThread: () => Effect.die("unused"),
  restore: () => Effect.void,
  syncSettings: () => Effect.void,
  completedRuns: Stream.empty,
  freshStartRecords: () => Effect.die("unused"),
  startFresh: () => Effect.void,
  pin: () => Effect.void,
  unpin: () => Effect.void,
  start: () => Effect.void,
  getTurnState: () => Effect.succeed("pending" as const),
  replayPending: () => Effect.void,
  interrupt: () => Effect.void,
  listPendingStartedRunIds: () => Effect.succeed([]),
});

/** One environment's crew over its own database, with its open features faked. */
const crewLayer = (openFeatures: ReadonlyArray<{ featureId: string; title: string }>) =>
  Layer.mergeAll(
    CrewServiceLive.pipe(
      Layer.provideMerge(CrewStoreLive),
      Layer.provideMerge(BotStore.layer),
      Layer.provide(quietRuntime),
    ),
    Layer.mock(FeatureService)({
      listOpenByWorkflow: (workflowId) =>
        Effect.succeed(workflowId === WORKFLOW_ID ? openFeatures : []),
    }),
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const describedAs = (environment: typeof laptop) =>
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      ...environment,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: false },
    }),
  });

const boxCaller = (access: string): McpInvocationContext.McpInvocationScope =>
  ({
    environmentId: box.environmentId,
    requestNamespace: "link",
    thread: undefined,
    client: { linked: true, access },
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  }) as unknown as McpInvocationContext.McpInvocationScope;

const SyncParametersJson = Schema.toCodecJson(LinkWorkflowSync.parametersSchema);
const encodeSyncParameters = Schema.encodeUnknownEffect(SyncParametersJson);
const decodeSyncParameters = Schema.decodeUnknownEffect(SyncParametersJson);

const makeEnvironments = (
  options: {
    readonly openFeaturesOnBox?: ReadonlyArray<{ featureId: string; title: string }>;
    readonly linkAccess?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const boxContext = yield* Layer.build(
      WorkflowSharingLive.pipe(
        Layer.provideMerge(crewLayer(options.openFeaturesOnBox ?? [])),
        Layer.provide(describedAs(box)),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.fresh,
      ),
    );
    const boxSharing = Context.get(boxContext, WorkflowSharing);
    const online = yield* Ref.make(true);
    const calls = yield* Ref.make(0);
    // The laptop reaches the box through the tool's parameters as JSON, as a link sends them.
    const forward = (params: unknown) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(online))) {
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Box stopped answering.",
          });
        }
        yield* Ref.update(calls, (count) => count + 1);
        const encoded = yield* encodeSyncParameters(params).pipe(Effect.orDie);
        const received = yield* decodeSyncParameters(JSON.parse(JSON.stringify(encoded))).pipe(
          Effect.orDie,
        );
        return yield* boxSharing.receive(boxCaller(options.linkAccess ?? "full-access"), received);
      });
    const linkSummary = Effect.gen(function* () {
      return {
        environmentId: box.environmentId,
        label: box.label,
        status: (yield* Ref.get(online)) ? "reachable" : "unreachable",
      };
    });
    const laptopContext = yield* Layer.build(
      WorkflowSharingLive.pipe(
        Layer.provideMerge(crewLayer([])),
        Layer.provide(describedAs(laptop)),
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            list: linkSummary.pipe(Effect.map((link) => [link as never])),
            get: () => linkSummary.pipe(Effect.map((link) => Option.some(link as never))),
          }),
        ),
        Layer.provide(
          Layer.mock(PeerForwarding.PeerForwarding)({
            call: (_scope, tool, environmentId, params) =>
              tool.name === LinkWorkflowSync.name && environmentId === box.environmentId
                ? (forward(params) as never)
                : Effect.die(`unexpected ${tool.name}`),
          }),
        ),
        Layer.fresh,
      ),
    );
    const laptopCrew = Context.get(laptopContext, CrewService);
    const laptopSharing = Context.get(laptopContext, WorkflowSharing);
    const boxCrew = Context.get(boxContext, CrewService);

    // The laptop's Social media workflow: a lead and one crew role, its own.
    for (const [id, name] of [
      ["role:social-lead", "Social lead"],
      ["role:writer", "Writer"],
    ] as const) {
      yield* laptopCrew.createRole({
        id,
        name,
        instructions: `You are the ${name}.`,
        modelSelection,
      });
    }
    yield* laptopCrew.createWorkflow({
      id: WORKFLOW_ID,
      name: "Social media",
      instructions: "Draft, then post.",
      leadRoleId: "role:social-lead",
      crewRoleIds: ["role:writer"],
    });

    const share = (input: Partial<WorkflowShareSetInput> = {}) =>
      laptopSharing.setShare({
        workflowId: WORKFLOW_ID,
        environmentId: box.environmentId,
        label: box.label,
        shared: true,
        ...input,
      });
    // The server syncs after each Library change; here each step syncs itself.
    const shareNow = (input: Partial<WorkflowShareSetInput> = {}) =>
      share(input).pipe(Effect.tap(() => laptopSharing.sync));
    const shareState = laptopSharing
      .shares(WORKFLOW_ID)
      .pipe(
        Effect.map((shares) => shares.find((entry) => entry.environmentId === box.environmentId)),
      );
    return {
      laptopCrew,
      laptopSharing,
      boxCrew,
      boxSharing,
      online,
      calls,
      share,
      shareNow,
      shareState,
    };
  });

describe("WorkflowSharing", () => {
  it.effect("ticking a machine gives it the workflow and its roles, managed from here", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { boxCrew, shareNow, shareState } = yield* makeEnvironments();
        yield* shareNow();

        const copy = yield* boxCrew.getWorkflow(WORKFLOW_ID);
        expect(copy).toMatchObject({
          name: "Social media",
          instructions: "Draft, then post.",
          leadRoleId: "role:social-lead",
          crewRoleIds: ["role:writer"],
          managedBy: laptop,
        });
        expect(yield* boxCrew.getRole("role:writer")).toMatchObject({
          instructions: "You are the Writer.",
          modelSelection,
          managedBy: laptop,
        });
        expect(yield* shareState).toMatchObject({
          shared: true,
          state: "synced",
          syncedAt: expect.any(String),
          error: null,
        });

        // A copy is edited only where it's owned.
        const edit = yield* boxCrew
          .updateWorkflow({
            id: WORKFLOW_ID,
            name: "Mine now",
            instructions: "Post it.",
            leadRoleId: "role:social-lead",
            crewRoleIds: [],
            expectedRevision: copy!.revision,
          })
          .pipe(Effect.flip);
        expect(edit.message).toBe("Social media is managed from Laptop. Change it there.");
        const role = (yield* boxCrew.getRole("role:writer"))!;
        const roleEdit = yield* boxCrew
          .updateRole({ ...role, instructions: "Mine.", expectedRevision: role.revision })
          .pipe(Effect.flip);
        expect(roleEdit.message).toBe("Writer is managed from Laptop. Change it there.");
      }),
    ),
  );

  it.effect("edits to the workflow and its roles on the owner reach the ticked machine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { laptopCrew, boxCrew, shareNow, laptopSharing, calls } = yield* makeEnvironments();
        yield* shareNow();
        const before = (yield* boxCrew.getWorkflow(WORKFLOW_ID))!;

        // Nothing changed, nothing is sent.
        const sent = yield* Ref.get(calls);
        yield* laptopSharing.sync;
        expect(yield* Ref.get(calls)).toBe(sent);

        const workflow = (yield* laptopCrew.getWorkflow(WORKFLOW_ID))!;
        yield* laptopCrew.updateWorkflow({
          ...workflow,
          instructions: "Draft, review, then post.",
          expectedRevision: workflow.revision,
        });
        const writer = (yield* laptopCrew.getRole("role:writer"))!;
        yield* laptopCrew.updateRole({
          ...writer,
          instructions: "You write short posts.",
          expectedRevision: writer.revision,
        });
        yield* laptopSharing.sync;

        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toMatchObject({
          instructions: "Draft, review, then post.",
          revision: before.revision + 1,
          managedBy: laptop,
        });
        expect(yield* boxCrew.getRole("role:writer")).toMatchObject({
          instructions: "You write short posts.",
          managedBy: laptop,
        });
      }),
    ),
  );

  it.effect(
    "unticking warns about features running on it there, then removes it without touching them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = [{ featureId: "feature:launch", title: "Launch post" }];
          const { boxCrew, laptopSharing, share, shareNow, shareState } = yield* makeEnvironments({
            openFeaturesOnBox: running,
          });
          yield* shareNow();
          // A feature on the box runs on it: its crew member and run are its own snapshots.
          const member = yield* boxCrew.createMember({
            id: "feature-member:launch:writer",
            projectId,
            featureId: "feature:launch",
            roleId: "role:writer",
            name: "Writer",
            instructions: "You are the Writer.",
            modelSelection,
            runtimeMode: "full-access",
          });
          const run = yield* boxCrew.createRun({
            id: "run:launch-writer",
            memberId: member.id,
            projectId,
            taskText: "Write the launch post.",
          });

          // Asked first: it still runs there, so nothing changes until confirmed.
          expect(yield* share({ shared: false })).toEqual({
            applied: false,
            openFeatures: running,
          });
          expect(yield* shareState).toMatchObject({ shared: true, state: "synced" });

          expect(yield* share({ shared: false, confirmed: true })).toMatchObject({ applied: true });
          expect(yield* shareState).toMatchObject({ shared: false, state: "removing" });
          yield* laptopSharing.sync;

          expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();
          expect(yield* shareState).toBeUndefined();
          // Roles aren't deleted: they stay as the box's own, and the running work is untouched.
          expect(yield* boxCrew.getRole("role:writer")).toMatchObject({
            instructions: "You are the Writer.",
            managedBy: null,
          });
          expect(yield* boxCrew.getMember(member.id)).toEqual(member);
          expect((yield* boxCrew.getRun(run.id))?.run).toMatchObject({
            id: run.id,
            instructions: run.instructions,
            taskText: "Write the launch post.",
          });
        }),
      ),
  );

  it.effect("a machine that was offline gets the latest change once it answers again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { laptopCrew, boxCrew, laptopSharing, online, share, shareNow, shareState } =
          yield* makeEnvironments();
        yield* Ref.set(online, false);
        yield* shareNow();
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();
        expect(yield* shareState).toMatchObject({ shared: true, state: "pending", syncedAt: null });

        const workflow = (yield* laptopCrew.getWorkflow(WORKFLOW_ID))!;
        yield* laptopCrew.updateWorkflow({
          ...workflow,
          instructions: "Changed while the box was off.",
          expectedRevision: workflow.revision,
        });
        yield* laptopSharing.sync;
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();

        yield* Ref.set(online, true);
        yield* laptopSharing.sync;
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toMatchObject({
          instructions: "Changed while the box was off.",
          managedBy: laptop,
        });
        expect(yield* shareState).toMatchObject({ state: "synced" });

        // Unticked while it's off, it goes there once it's back.
        yield* Ref.set(online, false);
        expect(yield* share({ shared: false })).toMatchObject({ applied: true });
        yield* laptopSharing.sync;
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).not.toBeNull();
        expect(yield* shareState).toMatchObject({ state: "removing" });
        yield* Ref.set(online, true);
        yield* laptopSharing.sync;
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();
        expect(yield* shareState).toBeUndefined();
      }),
    ),
  );

  it.effect.each(["keep", "replace"] as const)(
    "a role the machine already has with other settings is shown and asked about (%s)",
    (choice) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { boxCrew, shareNow, shareState } = yield* makeEnvironments();
          // The box made its own Writer before.
          yield* boxCrew.createRole({
            id: "role:writer",
            name: "Box writer",
            instructions: "You write long posts.",
            modelSelection,
          });
          yield* shareNow();

          // Nothing is put there, and the box's role is untouched, until the person chooses.
          expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();
          expect(yield* boxCrew.getRole("role:social-lead")).toBeNull();
          expect(yield* boxCrew.getRole("role:writer")).toMatchObject({
            instructions: "You write long posts.",
            managedBy: null,
          });
          expect(yield* shareState).toMatchObject({
            state: "clash",
            syncedAt: null,
            clashes: [{ id: "role:writer", name: "Box writer" }],
          });

          yield* shareNow({ roleChoices: { "role:writer": choice } });
          expect(yield* shareState).toMatchObject({ state: "synced", clashes: [] });
          expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toMatchObject({
            crewRoleIds: ["role:writer"],
            managedBy: laptop,
          });
          expect(yield* boxCrew.getRole("role:writer")).toMatchObject(
            choice === "keep"
              ? { name: "Box writer", instructions: "You write long posts.", managedBy: null }
              : { name: "Writer", instructions: "You are the Writer.", managedBy: laptop },
          );
        }),
      ),
  );

  it.effect("only a full-access link changes the library there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { boxCrew, shareNow, shareState } = yield* makeEnvironments({
          linkAccess: "approval-required",
        });
        yield* shareNow();
        expect(yield* boxCrew.getWorkflow(WORKFLOW_ID)).toBeNull();
        expect(yield* shareState).toMatchObject({
          state: "pending",
          error: expect.stringContaining("sharing a workflow there needs full access"),
        });
      }),
    ),
  );
});
