# Bosun bots: implementation design

Status: in progress. The first foundation slice persists bot definitions and run-to-thread
links, dispatches through the current T3 orchestration engine, and replays queued runs after a
restart. Delegation, bot-origin attribution, scoped tools, client views, and structured outcomes
remain design work for later milestones. Stored tool grants are policy data at this stage; they
are not yet enforced at the provider or MCP boundary.

## Why Bosun needs bots

T3 Code makes an individual coding agent easy to run and supervise, but the person still has to
carry context between separate threads, decide who should do each kind of work, and track whether
the result actually reached a feature or pull request. Bosun aims to make that coordination
explicit and durable. The Captain gives the person one place to direct work; project Managers
keep project context; specialist bots handle planning, design, execution, and review with the
right instructions and tools. This is useful only if delegation, ownership, and outcomes remain
visible and recoverable, so bot messaging and status must be product state rather than prose in
a prompt.

## The behavior we want

A person talks to a **Captain**. The Captain delegates project work to that project's
**Manager**. The Manager assigns a feature to **Planner**, **Designer**, **Execution**, and
**Reviewer** bots as needed. Bots can ask each other for information, pause for a person, and
resume after a client disconnects or the server restarts. The person can always see who owns a
request, what is running, what is waiting, and the resulting thread, worktree, and pull request.

The first implementation should work for projects on **one environment**. A remote web, desktop,
or mobile client controls that environment through the existing authenticated connection. A
Captain spanning several environments needs explicit delegated access and a durable home for its
state; a client tab cannot serve as that home.

## Reuse the harness

Bosun's bot is a **role and policy**, not a new provider or a replacement for a T3 thread.

| Bosun concept | Existing T3 concept                             | What Bosun adds                                                                                                                     |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Project       | Environment-local project rooted at a directory | Manager assignment and feature list. A Bosun project does not require a permanently separate Git worktree.                          |
| Bot           | None                                            | Stable identity, role, instructions, provider/model choice, tool grants, and permission ceiling. Captain and Manager are bots too.  |
| Bot run       | Thread and provider session                     | A link from bot, feature, and task to one durable thread. A later task gets a new run/thread; a continuation uses the existing one. |
| Feature       | No dedicated record                             | Objective, owner, status, branch/worktree, related runs, and pull request links.                                                    |
| Handoff       | User message / turn today                       | Durable request from one bot to another, with correlation, outcome, and an explicit destination.                                    |

Today [`thread.turn.start`](../../packages/contracts/src/orchestration.ts) starts provider work,
and [`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)
runs it. The [engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) already
serializes commands, persists events and receipts, and projects state. Bot turns should enter
through this flow rather than launching provider CLIs or writing directly to SQLite.

### Where to change T3 Code

Keep Bosun's coordination code in a focused `apps/server/src/bots/` module. The existing
orchestration engine currently routes only `project` and `thread` aggregates; adding bot,
feature, and handoff cases throughout that upstream command union would make future T3 merges
harder. The bot module should own its records, command IDs, transitions, and restart recovery
using the server's SQLite infrastructure. It calls the existing
[`OrchestrationEngineService`](../../apps/server/src/orchestration/Services/OrchestrationEngine.ts)
to create bot threads and start their turns. It must not call a WebSocket handler from inside
the server.

**Milestone 1 integration decision:** target the orchestration runtime in this checkout. T3's
orchestration v2 has substantial code on a separate upstream branch, but its runtime and
subagent projection are not integrated here. Put thread creation, turn start, interruption,
and status lookup behind a narrow `BotThreadRuntime` service. Its first implementation uses
the current `OrchestrationEngineService` and projection query. The bot store keeps its own
IDs and lifecycle, so a later v2 implementation can replace this adapter without migrating
bot identity or handoff state. Allocate the T3 thread ID and deterministic command IDs before
dispatch; replay the same commands after a crash so T3's command receipts prevent duplicate
threads and turns. If the accepted turn-start event was never consumed, replay the pending
projected message ID with a persisted recovery attempt and a fresh command ID; this re-enqueues
the provider intent without adding another user message. The pending message may be a handoff
notice, not the original task. Do not depend on v2-only run or node IDs in bot records.
Replay queued bot runs only after the provider reactor has subscribed to domain events: the
reactor does not replay earlier turn-start events. Server startup owns that ordering.

The first slice uses [`BotThreadRuntime`](../../apps/server/src/bots/BotThreadRuntime.ts) for
this boundary and [`BotService`](../../apps/server/src/bots/BotService.ts) for persistence and
recovery. Its `started` state means T3 accepted the turn-start command; it does not mean the
provider finished the task. The linked T3 thread remains the source for current turn state.
The current turn command still uses T3's `user` message role for provider input. Bosun attaches
bot-origin context to that message; clients must label it as bot-authored instead of relying on
the T3 role alone. A run's `started` state is not a structured bot result.

| Area                                                                                                 | First change                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/contracts`](../../packages/contracts/src/rpc.ts)                                          | Add bot IDs, records, bounded command/result schemas, and read/operate RPCs. Add a `bots` environment capability so older clients can ignore the feature.                                                                      |
| `apps/server/src/bots/` (new)                                                                        | Implement durable bot definitions, run and handoff state, a dispatcher that resumes pending work after restart, and a small read model. Register its layer in [`server.ts`](../../apps/server/src/server.ts).                  |
| [`apps/server/src/orchestration`](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) | Reuse `thread.create` and `thread.turn.start` for execution. Link each bot run to its thread; let the existing provider reactor handle provider lifecycle, approvals, checkpoints, and diffs.                                  |
| [`apps/server/src/mcp`](../../apps/server/src/mcp/McpHttpServer.ts)                                  | Add scoped `bots.delegate`, `bots.respond`, and `bots.ask` tools. Extend the [per-thread MCP capability](../../apps/server/src/mcp/McpInvocationContext.ts) and resolve the caller's bot run from its authenticated thread ID. |
| [`apps/server/src/auth`](../../apps/server/src/auth/RpcAuthorization.ts)                             | Choose explicit read and operate scopes for every new RPC. A provider's scoped MCP credential must not become a general client credential.                                                                                     |
| [`packages/client-runtime`](../../packages/client-runtime/src/state/shell.ts) and clients            | Share connection, caching, and bot status logic between web and mobile; add web, desktop, and mobile views for ownership, pending requests, and run/thread navigation.                                                         |

For the first slice, launch a run in an existing project checkout. When feature worktrees are
added, move the reusable part of the
[`ws.ts` worktree bootstrap](../../apps/server/src/ws.ts) behind a server service using
[`GitWorkflowService`](../../apps/server/src/git/GitWorkflowService.ts). Both human and bot
thread creation should call that service, including its setup and failure handling. Do not
duplicate the bootstrap in the bot dispatcher.

The existing `project` is an environment-local workspace record, while a `thread` can point at a
Git worktree. For coding features, use one worktree and branch **per feature**. Several bot runs
may read that worktree, but only one execution run may write to it at a time. Reviewer runs should
use a read-only mode or a separate review checkout when their provider needs filesystem access.
Non-coding projects can have features without Git artifacts.

## State and ownership

Add small, typed records rather than encoding the hierarchy in prompt text or thread titles:

- **Bot definition:** `botId`, role, name, instructions revision, provider instance/model, allowed
  tools, and maximum runtime mode. Definitions belong to one environment. A project assignment
  selects its Manager and available crew; the Captain is environment-wide.
- **Feature:** `featureId`, `projectId`, objective, lifecycle status, owner Manager, optional
  worktree/branch and pull request references. A feature can have many bot runs.
- **Bot run:** `runId`, `botId`, `featureId` (or Captain task), `threadId`, parent request, status,
  and attempt. The thread remains the source for conversation, provider activity, checkpoints,
  approvals, and diffs.
- **Handoff:** `requestId`, source run, target bot, target feature, bounded request text/context,
  status, and eventual response. Keep a correlation ID so a Manager can connect a result to the
  exact request it made.

The owning server persists these records and their transitions. A request is accepted once,
queued once, and either completed, rejected, cancelled, or left visibly waiting. Repeating a
command with the same ID must return the same receipt, including after restart. Rebuild the
dispatch queue from persisted pending work on startup; never infer completion from a WebSocket
connection or a provider process exiting. State changes travel over typed contracts in
[`packages/contracts`](../../packages/contracts/src/orchestration.ts) and are projected into a
small shell summary plus on-demand detail, so the sidebar does not subscribe to every bot's full
conversation. Advertise a bot capability on the environment descriptor; older clients should
simply continue to show ordinary threads.

## Dispatch and conversations

1. The person sends the Captain a request. The server records a task and starts or resumes the
   Captain's thread. A direct project request can instead target its Manager.
2. The Captain sends a typed handoff to the selected Manager. The server checks that the project
   and target bot belong to this environment, persists the request, and schedules the Manager's
   run. The same mechanism lets a Manager delegate to crew and lets a crew bot ask another bot.
3. The recipient sees the request and a compact, bounded context package: objective, project and
   feature IDs, relevant prior decisions, and references to source threads/artifacts. It does not
   receive every conversation transcript by default.
4. When a bot finishes, the server records a structured outcome (`completed`, `needs-input`, or
   `failed`) plus a short summary and artifact references. The requester receives that outcome
   and can continue its thread. A bot asking a person routes through its Manager and Captain;
   the pending question remains visible until answered or cancelled.
5. The UI shows each task's owner, run status, pending questions, and links to the underlying
   threads. A person may inspect or interrupt any run, reassign work, and retry a failed handoff.

Use a **server-side dispatcher/reactor** for this flow. The decider records intent; the reactor
starts provider turns and records results through commands. Bot-originated requests carry actor
metadata in the message context and timeline, even though the current provider input is a T3
`user` message. The provider can still receive a clear task prompt assembled from the
persisted handoff. A provider's prose is not a reliable status protocol, so a dedicated tool or
explicit command reports a structured outcome. Do not advance a feature to `done` merely because
a turn ended.

Bound delegation depth, active runs per project, and handoff size. Reject cycles that would bounce
the same request among bots; allow a new, explicitly linked question when it has new information.
Keep one writer lease per feature worktree. Cancellation releases queued work immediately and
interrupts active provider work through the existing turn/session path; it does not silently undo
filesystem changes.

## Tools, permissions, and provider differences

Bot instructions determine how a role works; they are not an access-control mechanism. The server
must enforce the bot's project scope, tool grants, and runtime-mode ceiling before dispatching a
tool action or provider turn. Start with the existing per-thread MCP credential model in
[`McpSessionRegistry`](../../apps/server/src/mcp/McpSessionRegistry.ts); grant only the Bosun
handoff tools needed for that run. Do not give a bot an unrestricted environment RPC token.
Provider credentials and files stay on the owning environment, including for remote clients.

The [provider adapter boundary](./providers.md) still owns provider-specific setup. For each of
Codex, Claude, Cursor, Grok, OpenCode, and Antigravity, verify how to supply role instructions,
register the scoped handoff tools, resume a session, and apply its permission mode. If an adapter
cannot provide an equivalent control, report that capability as unsupported rather than claiming
the bot is restricted by prompt alone. Role/model selection uses a configured provider **instance**,
so separate accounts remain separate.

External actions such as pushing, opening or merging a PR, posting to Linear, or changing Figma
need an explicit grant in the bot's policy and an auditable action/result. The Manager can request
approval from the person through the Captain. Review and approval must remain attributable to
the actual actor.

## Delivery sequence

1. **Bot foundation:** persist bot definitions and run-to-thread links. Exercise a single
   internal bot run against an existing project to prove provider routing and restart recovery.
   This is infrastructure, not the first user-facing bot experience.
2. **First useful crew:** make the **Captain** the first bot the person talks to. Add durable
   requests/results, server-side dispatch, bounded context, and one
   Captain-to-Manager-to-Execution path. The Captain should accept a project request, delegate
   it, answer who owns it, and relay its result or question. Show the linked runs in web,
   desktop, and mobile. Cover retry, interruption, pending questions, and server restart with
   focused backend tests using receipts and worker drains.
3. **Features and specialists:** add feature ownership and worktree writer coordination, then Planner,
   Designer, and Reviewer roles. Integrate GitHub/Linear/Figma only where the assigned role needs
   them. Link PRs to both feature and underlying thread.
4. **Multi-environment Captain:** design explicit delegated credentials, routing, and failure
   behavior once the single-environment flow is proven. Preserve the rule that each environment
   runs providers and accesses files only for projects it owns.

For each user-facing slice, update the contract, bot-domain persistence/replay, transition logic,
read model, dispatcher, and client runtime together. Check web, desktop, and mobile entry points; local,
remote, and tunnel connections; all provider adapters; and the reverse actions for
pause/cancel/retry. A minimal
acceptance scenario is: a person asks the Captain for a change, the Manager assigns Execution,
the run completes in a feature worktree, Reviewer returns findings, and the Captain can report
the exact thread, artifact, and current state after a server restart.

## Decisions to settle before coding

- Which role and project settings can a person edit, and which ship as defaults?
- May the Captain create projects, or only coordinate projects the person has added?
- Which actions require a person's approval regardless of a bot's provider permission mode?
- Should a Manager assign multiple features concurrently in the first release, or serialize them?

These are product decisions. They do not change the core ownership rule: durable bot state and
dispatch live on the server that owns the project, while T3 threads and provider adapters remain
the execution substrate.
