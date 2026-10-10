import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import type { CrewFeature } from "./crew.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Closed features the board keeps for its Done shelf, most recently updated first. */
const BOARD_CLOSED_LIMIT = 20;

export interface FeatureAtomsOptions {
  /** Re-reads a project's board when this signal changes, such as its stage threads' status. */
  readonly boardRefreshTrigger?: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly projectId: ProjectId };
  }) => Atom.Atom<unknown> | undefined;
}

export function createFeatureAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  options: FeatureAtomsOptions = {},
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:list",
    tag: WS_METHODS.featuresList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:detail",
    tag: WS_METHODS.featuresGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  /** A project's features with their workflow snapshots, read only while a view shows them. */
  const board = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:features:board",
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    ...(options.boardRefreshTrigger === undefined
      ? {}
      : { refreshTrigger: options.boardRefreshTrigger }),
    execute: (input: { readonly projectId: ProjectId }) =>
      request(WS_METHODS.featuresList, input).pipe(
        Effect.flatMap((records) =>
          Effect.forEach(
            [
              ...records.filter((record) => record.status === "open"),
              ...records
                .filter((record) => record.status === "closed")
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, BOARD_CLOSED_LIMIT),
            ],
            (record) =>
              record.workflowId === null
                ? Effect.succeed<CrewFeature>({ record, snapshot: null })
                : request(WS_METHODS.workflowsGetFeature, {
                    projectId: input.projectId,
                    featureId: record.id,
                  }).pipe(Effect.map((snapshot): CrewFeature => ({ record, snapshot }))),
            { concurrency: 4 },
          ),
        ),
      ),
  });
  const refreshProject = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: { projectId } }));
      registry.refresh(board({ environmentId, input: { projectId } }));
    });
  const refresh = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    featureId: string,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: { projectId } }));
      registry.refresh(detail({ environmentId, input: { projectId, featureId } }));
      registry.refresh(board({ environmentId, input: { projectId } }));
    });
  const onProjectChanged = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) => refreshProject(target.environmentId, target.input.projectId, registry);
  return {
    list,
    detail,
    board,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:create",
      tag: WS_METHODS.featuresCreate,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.id, registry),
    }),
    setStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:set-status",
      tag: WS_METHODS.featuresSetStatus,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.featureId, registry),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:start",
      tag: WS_METHODS.featuresStart,
      onSuccess: onProjectChanged,
    }),
    reopen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:reopen",
      tag: WS_METHODS.featuresReopen,
      onSuccess: onProjectChanged,
    }),
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:approve",
      tag: WS_METHODS.workflowsApprove,
      onSuccess: onProjectChanged,
    }),
    requestChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:request-changes",
      tag: WS_METHODS.workflowsRequestChanges,
      onSuccess: onProjectChanged,
    }),
    takeOver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:take-over",
      tag: WS_METHODS.workflowsTakeOver,
      onSuccess: onProjectChanged,
    }),
    markDone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:mark-done",
      tag: WS_METHODS.workflowsMarkDone,
      onSuccess: onProjectChanged,
    }),
    sendBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:send-back",
      tag: WS_METHODS.workflowsSendBack,
      onSuccess: onProjectChanged,
    }),
    skip: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:skip",
      tag: WS_METHODS.workflowsSkip,
      onSuccess: onProjectChanged,
    }),
    acceptAsIs: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:accept-as-is",
      tag: WS_METHODS.workflowsAcceptAsIs,
      onSuccess: onProjectChanged,
    }),
    oneMoreRound: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:one-more-round",
      tag: WS_METHODS.workflowsOneMoreRound,
      onSuccess: onProjectChanged,
    }),
    startNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:start-now",
      tag: WS_METHODS.workflowsStartNow,
      onSuccess: onProjectChanged,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:answer",
      tag: WS_METHODS.workflowsAnswer,
      onSuccess: onProjectChanged,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:retry",
      tag: WS_METHODS.workflowsRetry,
      onSuccess: onProjectChanged,
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:pause",
      tag: WS_METHODS.workflowsPause,
      onSuccess: onProjectChanged,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:resume",
      tag: WS_METHODS.workflowsResume,
      onSuccess: onProjectChanged,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:cancel",
      tag: WS_METHODS.workflowsCancel,
      onSuccess: onProjectChanged,
    }),
  };
}
