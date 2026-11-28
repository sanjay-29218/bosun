import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  projectHeadquartersThreadId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { MANAGER_INSTRUCTIONS_TOOLS } from "../mcp/toolkits/crew/managerInstructionsTools.ts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { BotService } from "../bots/BotService.ts";
import { BotReach } from "../bots/BotReach.ts";
import { BotTransfer } from "../bots/BotTransfer.ts";
import { CrewApprovals } from "../crew/CrewApprovals.ts";
import { crewMcpCapabilities } from "../crew/crewMcpCapabilities.ts";
import { CrewService } from "../crew/CrewService.ts";
import { LibraryImports } from "../crew/LibraryImports.ts";
import { ProjectRequests } from "../crew/ProjectRequests.ts";
import { CrewStore } from "../crew/CrewStore.ts";
import { FeatureService } from "../features/FeatureService.ts";
import { IssueService as BoardIssueService } from "../issues/IssueService.ts";
import { TicketService } from "../tickets/TicketService.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { TaskFolders } from "../workspace/TaskFolders.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadIssueService } from "../orchestration-v2/ThreadIssueService.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { Workflows } from "../workflows/Workflows.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { IssueService } from "../issue/IssueService.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { FeedbackStore } from "../feedback/FeedbackStore.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { DocumentText } from "./DocumentText.ts";
import { EnvironmentThemeService } from "../environmentTheme.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(AnalyticsService)({}),
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(EnvironmentThemeService)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(TaskFolders)({}),
  Layer.mock(IssueService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(BotReach)({}),
  Layer.mock(BotTransfer)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(Workflows)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService)({}),
  Layer.mock(GitManager)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  Layer.mock(FeedbackStore)({}),
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadIssueService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
  // Bosun's crew tools.
  Layer.mock(BotService)({}),
  Layer.mock(CrewApprovals)({}),
  Layer.mock(CrewService)({}),
  Layer.mock(LibraryImports)({}),
  Layer.mock(CrewStore)({}),
  Layer.mock(ProjectRequests)({}),
  Layer.mock(FeatureService)({}),
  Layer.mock(BoardIssueService)({}),
  Layer.mock(TicketService)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = () =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true },
    ),
  )
    .map((entry) => entry.value)
    .join("");

const threadScope = (
  threadId = ThreadId.make("context-budget"),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("context-budget"),
  requestNamespace: "context-budget",
  thread: {
    threadId,
    providerSessionId: "context-budget",
    providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  },
  client: undefined,
  capabilities: crewMcpCapabilities(
    threadId,
    new Set(["orchestration", "worktree", "pull-requests", "preview", "device"]),
  ),
  issuedAt: 0,
});

const clientProfile = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "context-budget", version: "1.0.0" },
};

/** The tools/list a thread with `scope` gets: tool visibility reads the caller from its fiber. */
const listedTo = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    return mcp.tools.filter(
      ({ annotations }) =>
        Context.getOrUndefined(annotations, McpSchema.EnabledWhen)?.(clientProfile) ?? true,
    );
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

// The model sees these fields. outputSchema and annotations are protocol metadata.
const toolListJsonBytes = (tools: McpServer.McpServer["Service"]["tools"]) =>
  utf8Bytes(
    JSON.stringify(
      tools.map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    ),
  );

const layerAllTools = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

// Claude Code loads these tools up front instead of behind ToolSearch, outside this budget.
it.effect("only request_secret and send_to_user ask Claude Code to load them up front", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const alwaysLoad = mcp.tools
      .filter(({ tool }) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)
      .map(({ tool }) => [tool.name, tool._meta]);
    expect(alwaysLoad).toEqual([
      ["request_secret", { "anthropic/alwaysLoad": true }],
      ["send_to_user", { "anthropic/alwaysLoad": true }],
    ]);
  }).pipe(Effect.provide(layerAllTools)),
);

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const measured = {
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
      // A plain thread's list: crew threads add the crew tools.
      mcpToolListJsonBytes: toolListJsonBytes(yield* listedTo(threadScope())),
    };

    expect(
      measured,
      "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }).pipe(Effect.provide(layerAllTools)),
);

it.effect("every crew role and a plain thread reach every tool, with no grants", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const names = (tools: McpServer.McpServer["Service"]["tools"]) =>
      tools.map(({ tool }) => tool.name);
    // Only linked environments use the link tools, and only a feature's crew member asks the
    // person in its own thread. These scopes have agent feedback off, no background wait, and
    // t3_workflow serves only clients outside a thread.
    const notListed = new Set([
      "t3_feedback",
      "t3_background_wait",
      "t3_workflow",
      "t3_bot_link_projects",
      "t3_bot_link_task",
      "t3_bot_link_notices",
      "t3_crew_link_library",
      "t3_crew_link_library_sync",
      "t3_bot_link_import",
      "t3_bot_link_rehome",
      "crew_ask_person",
    ]);
    const all = names(mcp.tools).filter((name) => !notListed.has(name));
    const manager = yield* listedTo(
      threadScope(projectHeadquartersThreadId(ProjectId.make("context-budget"))),
    );
    expect(names(manager)).toEqual(all);
    // A feature's lead, or any crew role's thread, gets the same but the manager's own tools.
    const standingOnly: ReadonlySet<string> = new Set(MANAGER_INSTRUCTIONS_TOOLS);
    const withoutStanding = all.filter((name) => !standingOnly.has(name));
    for (const crew of ["bot-run:feature-lead:x", "bot-run:builder-run"]) {
      expect(names(yield* listedTo(threadScope(ThreadId.make(crew))))).toEqual(withoutStanding);
    }
    // A plain task starts features, delegates, makes worktrees and pull requests on its own;
    // it lacks only the tools that act for a crew run.
    const plain = names(yield* listedTo(threadScope()));
    expect(plain).toEqual(withoutStanding.filter((name) => !name.startsWith("crew_")));
    expect(plain).toEqual(
      expect.arrayContaining([
        "t3_feature_start",
        "t3_role_create",
        "t3_bot_create",
        "t3_project_send",
        "delegate_task",
      ]),
    );
  }).pipe(Effect.provide(layerAllTools)),
);
