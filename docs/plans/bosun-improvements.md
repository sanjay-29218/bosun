# Bosun improvements plan

Status: proposal, for item-by-item approval. Read from `origin/staging` at `98d577ffb4` (#71 merged).
Counts come from a read-only look at `~/.bosun/userdata/statev2.sqlite` on 2026-11-05.
Bosun differs from upstream merge-base `935818e422` in 588 files: 311 modified, 273 added.

Sizes: S is under a day, M is a few days, L is a week or more. A **task** is one PR with no plan
or QA round. A **feature** gets a lead and crew.

## A. Thin layer on T3 Code (#72)

### A1. Crew capability for feature leads: done

- `crewMcpCapabilities.ts:65` grants `crew` to every crew thread (`isCrewThread`, line 14), and
  feature leads are crew threads. Confirmed on staging. Tick it off on #72.

### A2. Dead code and dead tables

- Still on staging: `CrewStore.canDelegate` (`CrewStore.ts:308`, `:632`), which has no callers.
  `CrewThreadRuntime.interrupt` and `handoffCommandPrefix` (`CrewThreadRuntime.ts:127`, `:383`),
  which also have no callers. The `bosun-run:` prefix (`CrewThreadRuntime.ts:126`,
  `crewMcpCapabilities.ts:15`, `:52`); no thread uses it. `crewRequest` (`orchestrationV2.ts:531`,
  `:2178`, `:3473`, `Orchestrator.ts:4032`, `workGroups.ts:52`, `SidebarWorkGroup.tsx:28`, mobile
  `thread-list-v2-items.tsx:641`). No server code writes `crewRequest`; 7 old threads carry it.
  #71 already removed `crew.start`.
- Tables: `crew_handoffs` has 34 rows and `crew_handoff_receipts` has 104, all from before
  Oct 31, and no code reads them. Migration 108 keeps 4 disabled `bot-builder:` members only
  because of the `crew_handoffs` foreign key (`108_RemoveProjectBuilders.ts:7`, `:28`).
- `features.branch`/`worktree_path` are **not empty**. 7 of 26 features (the last created
  Nov 2) still use them as a fallback (`FeatureWorkspaces.ts:70`).
- Fix: delete the code. In one migration, drop both handoff tables and the 4 builder members.
  Copy the 7 features' branch and worktree onto their lead threads, then drop the columns. Old
  `crewRequest` threads lose their grouping.
- Size S, task. After #70 merges, because #70 edits `workGroups.ts` and `SidebarWorkGroup.tsx`
  and adds migration 109.
- Accept: no reference to the removed names is left outside old migrations. The 7 old features
  still open their worktree. Tests pass.

### A3. Bosun RPC in `contracts/bosun/`

- `packages/contracts/src/bosun/` doesn't exist. #71 alone added 44 lines to `rpc.ts` and edited
  `clientRpcPermissions.ts` and `RpcInstrumentation.ts`.
- Fix: move Bosun's methods, scopes and span maps there. Each core file spreads them in one line.
- Size M, task. No conflict with #68 or #69 beyond rebase noise. Do it before C2 and C5, which add
  RPC.
- Accept: `rpc.ts`, `RpcAuthorization.ts`, `clientRpcPermissions.ts` and `RpcInstrumentation.ts`
  each show a diff of 2 lines or fewer against the merge-base. Permission tests pass.

### A4. Stock prompts in code

- 13 migrations rewrite instructions in place (074, 081, 082, 084, 087, 089, 091, 093, 095,
  098, 103, 106, 108). Every wording change costs one more.
- Fix: `crewPrompts.ts` stays the source. Rows store `stock_key`, plus `edited` text only when a
  person changed it, and they read the stock text at runtime. One migration maps the current
  rows: rows matching stock text become stock, the rest are kept as edits.
- Size M, feature (migration plus an editor "reset to stock" path).
- Conflicts: #70 edits `crewPrompts.ts`, so merge #70 first. B4 changes prompt text, so do it
  after A4 and it needs no migration.
- Accept: changing a stock prompt needs no migration. Edited prompts survive. Role editor shows
  stock vs edited.

### A5. One `delegate_task` hook

- `OrchestratorMcpService.ts` (3557 lines) holds `latestCrewThread` `:1030`,
  `resolveCrewMember` `:1052`, `resolveTaskIssue` `:1080` and crew member reuse `:2511`.
- Fix: one `CrewDelegation` hook service that upstream `delegate_task` calls once, before and
  after creating the child. The crew logic moves to `apps/server/src/crew/`.
- Size M, task. After A3. It touches the same handler as B4's sizing rules, so don't run them
  at the same time.
- Accept: `OrchestratorMcpService.ts` has 15 lines or fewer of Bosun diff. The delegate tests
  pass unchanged.

### A6. Generic thread `extensions`

- `feature`, `issue`, `crewRequest` and `thread.crew-stage.set` (`orchestrationV2.ts:3469`) are
  typed into the core thread schema and projection.
- Fix: one `extensions: Record<namespace, json>` field and one `thread.extensions.set` command.
  Bosun decodes its namespace in client-runtime. Separately, offer `thread.conversation.restart`
  and `user-input.open` upstream.
- Size L, feature. After A2 (which removes `crewRequest`) and after #69, which adds a bot owner
  to threads and should land straight into `extensions`.
- Accept: no Bosun field left in the core thread schema. Projections replay old events into
  `extensions`. Web and mobile render the same.

### A7. Client slot registry (web, then mobile)

- Bosun UI is inlined into `Sidebar.tsx`, `CommandPalette.tsx`, `ChatView.tsx`,
  `mainAppLocation.ts` and 36 mobile screens.
- Fix: registries for sidebar section, palette command, row decorator, route and right-panel
  tab. Bosun registers from its own folder.
- Size L, feature, web first. After #69 (rail and sidebar) and A6 (decorators read
  `extensions`). Mobile is a second feature.
- Accept: those web files keep only a registry call. No UI change, shown by before/after
  captures.

## B. Token waste and wake-ups

Measured: HQ "Viral Shot Lead" ran 47 turns, and feature reports started **40 of them (85%)**.
Captain ran 180, and reports started 40. There are 82 reports in all: 22 "waiting on the
person" and 60 "[completed]". One feature sent its HQ 12 reports, another 10. Feature leads ran
236 turns, and crew task results started 132 of them (56%).

### B1. Stale and stacked notices

- `FeatureReportReactor.ts:128` posts each notice with `queue_after_active`, so each one is a
  full HQ turn. A busy HQ gets them later, one turn each, even when they're stale. Of the 22
  "waiting" notices, 2 were already answered when their HQ turn started. No notice ever says
  the wait ended.
- Fix: hold notices per requester while it is busy. When it goes idle, post **one** digest:
  the latest state per feature, without requests that were answered meanwhile. Merge notices
  (`MergeNotices.ts:132`) and request replies (`ProjectRequests.ts:184`, `:216`) use the same
  outbox.
- Size M, feature, with B2 (same reactor). Conflicts with #70's `FeatureService.ts` report code,
  so merge #70 first.
- Accept: N notices arriving during one HQ turn start at most 1 more turn. A request answered
  before delivery is not reported. Covered by reactor tests with a drained effect worker.

### B2. Report only on stage end

- `reportRun` (`FeatureReportReactor.ts:154`) reports **every** lead stop. The open-crew skip
  (`:165`) still lets progress through. At least 22 of the 60 "[completed]" reports say work is
  still going ("QA and the Reviewer are now checking it", "back with the Builder").
- Fix: tell the requester only when the lead calls `t3_feature_finish`, waits on the person,
  fails, or stops with nothing running for the quiet period (as children already do,
  `FeatureService.ts:288`). Crew results to the lead stay as they are: that is upstream
  `delegate_task` delivery, and the lead needs them.
- Size: in B1's feature. Needs an eval case in `evals/mcp-tool-use` for the lead's finish call.
- Accept: a feature whose lead stops 5 times and finishes once reports once (plus any
  needs-you notices).

### B3. Long HQ and lead threads start over

- The automatic fresh start exists (`headquartersFreshStart.ts:8`: 100k tokens, after 30 quiet
  minutes; `CrewService.ts:1184`). It is opt-in, and all 4 bots are set to `compact`, so it
  never runs. Project managers are standing threads and default to compact too. Leads end with
  their feature.
- Fix: default HQ and Project manager threads to `new-session`. Existing bots stay as they are
  unless the person switches. Leave leads on provider compaction.
- Size S, task. After #69, which moves HQ working folders and sessions.
- Accept: a standing thread above the threshold starts a briefed new session after the quiet
  period. The setting shows the new default.

### B4. Size the process to the work

- The PM already picks task vs feature (`crewPrompts.ts:15`). Inside a feature, the default
  workflow runs Planner → Builder → QA → Reviewer (`crewPrompts.ts:37`), about 6.6 crew tasks per
  feature (132 over 20 leads). Bots that start features directly skip the PM's sizing rule.
- Fix: add a "Quick" workflow (Builder, then one Reviewer pass, with no plan approval) for
  briefs the PM or lead judges small. Route HQ feature starts through the same rule.
- Size S, task (prompt and stock workflow). After A4. Run the evals in `evals/README.md`.
- Accept: eval cases put a copy fix on Quick and a multi-surface change on the full workflow.

## C. Rough edges #71 left

### C1. Opening a Project manager costs a turn

- `ensureStanding` dispatches the queued run (`CrewService.ts:1134`), whose first message uses
  `start_immediately` (`CrewThreadRuntime.ts:171`). Opening a bot's HQ does the same.
- Fix: create the standing thread idle. Its instructions go in as context, and the first real
  message (from the person or a request) starts the turn.
- Size S, task. Touches `ensureStanding`, which #69 also edits, so land it before #69 starts or
  merge it in.
- Accept: opening a new PM or HQ creates no run. The first message runs with the instructions
  applied.

### C2. Ordinary threads can't reach the Project manager

- `projectRequests` is gated with `null` needs (`crewToolGrants.ts:94`), which still requires
  crew grants (`:33`). A plain thread in the project never sees `t3_project_send`.
- Fix: list the three tools to any thread in a project with a PM. The handler limits it to that
  project.
- Size S, task, with C5 (same settings and gates). After A3. Run the MCP tool-use evals: the
  tool list changes.
- Accept: a plain thread can send, list and reply to requests for its own project only.

### C3. Linked environments can't reach their Project manager

- `projectRequests` has no `forLinks` entry, so linked sessions never see it
  (`crewToolGrants.ts:30`, `:94`). #66 added bot reach but not request reach; #48 stays open.
- Fix: add the tools to `forLinks`. The handler checks the link's project access and routes to
  that environment's PM.
- Size M, task. After C2. Test through the linked-environment fixtures from #66.
- Accept: a bot on environment A sends a request to a project on B and gets the reply. A link
  without access is refused.

### C4. Archived panel offers a Delete that fails

- `ArchivedThreadsPanel.tsx:134` always shows Delete. The server refuses standing threads
  (`Orchestrator.ts:300`), and the dialog says "this thread".
- Fix: use the standing-thread check `threadActionMenu.logic.ts` already has, and hide Delete.
  Name the thread in the dialog.
- Size S, task. Bundle it with C1.
- Accept: an archived PM or HQ shows only Unarchive, with before/after captures.

### C5. No way to opt out of a Project manager

- Every project gets one on first use (`CrewService.ts:1157`), with no off switch.
- Fix (recommended): a per-project switch in Project settings (`ProjectManagerSettings.tsx`) and
  a global default. When it's off, requests and features go to the requester directly, and the
  PM thread is archived. Turning it back on unarchives the same thread.
- Size M, feature, with C2.
- Accept: with the switch off, no PM thread or run is created, and `t3_project_send` says the
  project has no manager. Turning it back on restores the old thread.

## D. In flight (not planned here)

- **#68 / PR #70** (child features nest): it edits `crewPrompts.ts`, `FeatureService.ts`,
  `workGroups.ts`, `Sidebar.tsx`, `SidebarWorkGroup.tsx`, and adds migration 109. **Merge it first.**
  A2, A4 and B1/B2 all build on those files, and any new migration takes 110 or higher.
- **#69** (bot home folder) edits `ensureHeadquarters`/`ensureStanding`, thread ownership,
  schedules and the rail. Do C1 before it, and B3, A6 and A7 after it.

## Suggested waves (at most 2 at a time)

| Wave | Slot 1                            | Slot 2                                     |
| ---- | --------------------------------- | ------------------------------------------ |
| 0    | Merge PR #70                      | C1 + C4 (task)                             |
| 1    | B1 + B2, fewer wake-ups (feature) | A2, dead code (task)                       |
| 2    | #69, bot home (feature)           | A3, RPC move (task)                        |
| 3    | B3, auto new session (task)       | C2 + C5, PM reach and off switch (feature) |
| 4    | A4, stock prompts (feature)       | C3, linked PM (task)                       |
| 5    | B4, quick workflow (task)         | A5, delegate hook (task)                   |
| 6    | A6, extensions (feature)          | none                                       |
| 7    | A7 web (feature)                  | then A7 mobile                             |

Each PR reports the new count of modified upstream files against `935818e422`.
