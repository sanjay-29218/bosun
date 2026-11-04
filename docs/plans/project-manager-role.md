# Plan: a Project manager per project, and Feature managers per feature

Status: proposal, research only. Base: `origin/staging` at `19108ec227`. The person's answers to
the first round of open questions are folded in (see [Decisions](#decisions)).

## Summary

Today's "Project manager" leads one feature at a time, so it becomes the **Feature manager**. Its
role ID moves to `role:feature-manager`. A new **Project manager** takes over
`role:project-manager` and gets one standing thread per project, which lives as long as the
project, like a bot's headquarters lives as long as the bot. It is configured like a bot, but for
one project: instructions, model, access.

- **Requests:** bots hand requests for a project to that thread by default. They start work in a
  project directly only when the person asks.
- **Backlog:** the Project manager owns it (issues and milestones).
- **Judgement:** it decides task, feature or milestone and when to run work in parallel. It leads a
  milestone itself, or hands it to an Epic's Feature manager.
- **After merges:** it answers its Feature managers, and it closes issues and milestones once their
  pull requests merge into `staging`.

Most of the machinery exists already:

- Standing threads: bot headquarters.
- Requester reports: `FeatureReportReactor`.
- Parent and child features: the Epic workflow.
- Issue tools: `crew_create_todo`, `crew_update_todo`, `crew_link_issue`, `crew_list_issues`.
- Merge detection: `PullRequestWatchReactor`.

The plan mostly wires these into one new standing thread, plus a rename.

## What exists today

| Thing | Where | What it is |
| --- | --- | --- |
| Bot | `BotStore`, `packages/contracts/src/bots.ts` | Owns projects (`project.botId`). Acts in crew runs by ownership, not grants. |
| Bot headquarters (HQ) | `CrewService.ensureHeadquarters`, run `bot-hq:<botId>`, thread `bot-run:bot-hq:<botId>` | One pinned, long-lived thread per bot. It lives outside its projects, and the HQ's project is hidden. It is restored if deleted, and it compacts or starts a fresh session (`headquartersFreshStart.ts`). |
| HQ task text | `headquartersTask()` in `CrewService.ts` | Small work goes to `delegate_task` (`target.projectId`, worktree), with a `PROJECT_MANAGER_BRIEF` that says "You are this project's manager for one request". Bigger work goes to `t3_feature_start`. |
| `role:project-manager` | `PROJECT_MANAGER_ROLE_ID` (contracts) | Default lead role of **Feature delivery** and **Epic**. Named "Project manager". Its instructions are `PROJECT_MANAGER_INSTRUCTIONS` in `crewPrompts.ts`, which say "You lead one project's work", although it leads one feature. |
| `bot-manager:<projectId>` | `projectManagerMemberId`, `ensureProjectManager` | One crew **member** per project, made from `role:project-manager` on first use (with a `bot-builder:<projectId>` builder). It is an identity, **not a thread**. Every feature's lead run uses this member. |
| Feature lead run | `FeatureService.startLead`, run `hashed("feature-lead", featureId, memberId)`, thread `bot-run:feature-lead:<hash>` | **One thread per feature**, titled with the member's name ("Project manager"). It opens with the brief as its first message. Its task holds the workflow, the crew and the brief. The run ID is hashed from the member ID, so renaming the member would orphan running leads. |
| Crew | `assembleCrew`, `delegate_task` + `crewMember` | Feature-scoped members. Their threads are subagents of the lead, in the lead's worktree. |
| Epic | `EPIC_INSTRUCTIONS` | The parent lead plans a split, gets approval, starts children with `t3_feature_start` (at most two at once, stacked with `baseBranch`), runs an integration check and reports pull requests in merge order. |
| Children | `features.parent_feature_id` (096), `t3_feature_finish`, quiet-child watcher | A child reports to its parent's lead. |
| Requester | `features.requester_thread_id` (098), `FeatureReportReactor` | A feature started outside a feature reports to the thread that started it. That is the top thread when the starter is a subagent. It reports when the lead waits on the person and each time it stops with no crew task open. |
| `t3_feature_start` | `mcp/toolkits/features/handlers.ts` | Starts in the caller's project. A bot's HQ may target projects its bot owns (#50, closed). Other callers need full access. |
| Issues | `crew_list_issues` (reads milestones, parent issue and sub-issue progress), `crew_create_todo` (ticket or GitHub issue), `crew_update_todo` (close or reopen), `crew_link_issue` (feature ↔ issue); `FeatureService.create` links the first issue URL found in the brief | There are no milestone writes, no sub-issue writes and no issue comments. |
| PR merges | `PullRequestWatchReactor` | Sees `merged` on watched, linked PRs. Nothing reacts to a merge into a non-default branch. |

### Related issues

- **#49 (lead starts idle).** This describes the retired stage engine. On `origin/staging` the lead
  run opens with the brief (`startLead` passes `openingMessage`), and `startsIdle` no longer exists.
  Lead-and-crew (`b631961d2a`) fixed it, so PR #52 is superseded. Close both and keep the eval case
  `feature-lead-hands-plan-to-planner`, renamed in Phase 1.
- **#50 (bots can't start features in owned projects).** Closed by `51eb5c99ac` and `c047f66ad5`.
  That path stays. This plan makes the Project manager the default, and the bot uses the direct path
  only when the person asks.
- **#56 (Lineage misses started features).** In flight on
  `bosun/bot-thread-lineage-shows-started-feature-549f0e`, uncommitted, with migration `099`. It puts
  `requesterThreadId` on the lead's feature tag so Lineage can list features a thread started. **It
  is a dependency.** The Project manager's Lineage is how a person sees what it started.
- **Issues on delegated tasks.** In flight in Captain's subagent "Link issues to delegated tasks",
  branch `bosun/task-issue-links`, no commits yet. It adds an issue field to `delegate_task` and
  stores it on the task thread's tag. **It is a dependency.** Phase 3 reuses that field and storage,
  and gives `t3_feature_start` the same `issue` parameter.
- **#51 (board doesn't pick up new issues).** Not a dependency. It gets more visible once the
  Project manager creates issues all day.

Migration numbers: `098` is the newest on staging, #56 takes `099`, and task-issue-links may take
`100`. Number each phase's migration when it is rebased, not now.

## Role model

```
           Person ─────────────────────────────┐ (can open any thread directly)
              │                                 │
              ▼                                 ▼
        Bot HQ (Captain, Viral Shot Lead…)   one per bot, lives with the bot
              │  t3_project_send
              ▼
        Project manager   one per project, lives with the project (standing thread)
         │        │            │
         │ task   │ feature    │ milestone: led by the PM itself (features per part),
         │        │            │            or handed to an Epic, as drawn here
         ▼        ▼            ▼
      Task     Feature      Feature manager (Epic)
     thread    manager         │ t3_feature_start (children)
               │               ▼
               │            Feature manager × N (children, own worktree/branch/PR)
               ▼               │
     crew: Planner, Designer, Builder, QA Tester, Reviewer   (subagents, one per member per feature)
```

Reports flow back up the same edges:

- Crew report to their Feature manager, as subagent results.
- Child Feature managers report to the Epic's Feature manager (`t3_feature_finish`).
- Feature managers and tasks report to the Project manager (requester reports and subagent results).
- The Project manager answers the bot that sent the request (`t3_project_reply` on a stored request,
  Phase 2).

### Lifetimes

| Thread | How many | Lifetime | Workspace |
| --- | --- | --- | --- |
| Bot HQ | 1 per bot | As long as the bot. Compacts or fresh-starts. | None (hidden project) |
| **Project manager** | 1 per project, created on first use | As long as the project. Pinned, restored if deleted, compacts or fresh-starts like the HQ. | The project checkout, **read-only** by instruction |
| Feature manager | 1 per feature | Start to `t3_feature_finish` or close. Reopen reuses the same run. | The feature's worktree |
| Crew member | 1 per member per feature | The feature. Follow-ups go to the same thread. | The feature's worktree |
| Task | 1 per task | One result | Its own worktree |

### Who may do what

The server enforces what it can (grants, ownership, the run's project). The rest is in the
instructions, and the instructions are guidance, not authorization.

**Bot.** It talks to people and to the Project managers of projects it owns, and it creates
projects and manages the Library.

- By default it hands project work to that project's Project manager. It starts a feature or task
  in a project directly only when the person asks for that. The server keeps allowing both; this is
  instruction, not a limit.

**Project manager**

May:

- read the project's code and git state, including what each feature's branch changes
  (`git diff --name-only <base>...<branch>` from the project checkout, which shares its git
  directory with every feature worktree);
- create, list, comment on and close issues, tickets and milestones;
- start tasks (`delegate_task` in a worktree) and features (`t3_feature_start`, including Epic
  features) in **its own project**;
- answer a Feature manager's pending question (`t3_pending_request` respond), or redirect it
  (`t3_thread_send` to its lead thread). Permission approvals stay with the person:
  `t3_pending_request` can't approve them.
- stop a feature;
- report to the bot, or ask the bot and person a question;
- merge a pull request when the person asks it to, or when its instructions say so. By default
  the person merges.

May not:

- edit, commit or push in the project checkout;
- hand work to a feature's crew directly (`crewMember` stays lead-only, as today);
- touch other projects;
- change bots, roles or workflows.

**Feature manager.** Its job is unchanged. It runs its workflow with its crew, asks for decisions,
and calls `t3_feature_finish`.

- Its questions now reach the Project manager first, because the Project manager is the feature's
  requester. That already works through `FeatureReportReactor` for top-level features. An Epic
  child has no requester, and the quiet-child watcher skips a child waiting on input, so a child's
  question reaches its parent's lead only after Phase 2 adds that (see "Questions").
- It does not start sibling features (the Epic's Feature manager starts its own children). It does
  not close issues, and it does not talk to the bot.

**Crew.** Unchanged.

## End-to-end flows

### Simple work (one PR)

1. The person tells Captain: "Add a CSV export to the reports page in project X."
2. Captain calls `t3_project_send({ projectId: X, message })`. The server ensures X's Project manager
   thread exists, stores request R-7 with Captain's HQ as its requester, queues the message headed
   with R-7, and returns the request ID and thread link. Captain links it and ends its turn.
3. The Project manager checks the backlog (`crew_list_issues`) for an existing issue. It finds none,
   so it creates one (`crew_create_todo as: issue`, or a ticket when the project isn't on GitHub).
4. It judges the work: one clear change, so a **task** or a **feature**.
   - A task: `delegate_task` in a worktree, with `issue: "#123"` (task-issue-links).
   - A feature: `t3_feature_start({ title, brief, issue: "#123" })`. The issue is linked when the
     feature is created, so every thread shows it from the start.
5. The Project manager checks the open features (`t3_feature_list`, Phase 2) and their changed
   files. It starts this one at once, because it doesn't overlap any of them. It answers R-7 with
   `t3_project_reply` ("started feature …, issue #123"), leaving the request open.
6. The Feature manager runs Plan → Build → QA → Review.
   - When it needs a decision, it asks. `FeatureReportReactor` tells the Project manager, which
     answers the pending question from the brief, the issue or earlier decisions
     (`t3_pending_request` respond), or else asks Captain through R-7.
   - When it's done, the Builder opens the PR against `staging` with "Refs #123", and the Feature
     manager calls `t3_feature_finish`.
7. The Project manager hears the result in a later turn, as a server report with no sender. It looks
   up the open request for that work (`t3_project_requests`) and answers R-7 with
   `t3_project_reply({ done: true })`.
8. The person, or a bot, merges the PR into `staging`. The server sees the merge and tells the
   Project manager once (Phase 4). The Project manager closes #123 with a comment linking the PR.

### Big work (a milestone)

1. Steps 1–3 as above. The Project manager judges this as **big**: several reviewable PRs, several
   areas, needs sequencing or an integration check.
2. It creates a GitHub **milestone** and a parent issue in it (Phase 3). Then it picks who leads
   the milestone, depending on the work:
   - **It leads the milestone itself** when the parts are clear and mostly independent. It creates
     an issue per part in the milestone, as sub-issues of the parent. It starts each part as a
     feature with `issue` (and `baseBranch` to stack on another part). Each part reports to the
     Project manager as its requester. When an integration check is needed, it starts one as a task
     or a feature.
   - **It hands the milestone to an Epic** when the split needs planning or the parts are tangled.
     It starts one Epic feature with `issue` set to the parent issue and the milestone named in the
     brief. The Epic's Feature manager has its Planner propose the split and asks for approval; the
     Project manager approves when the request already settles it, otherwise it asks the bot. For
     each child, the Epic's Feature manager creates an issue in the milestone, as a sub-issue of the
     parent, and starts the child with `t3_feature_start({ issue, baseBranch? })`. Children report
     to the Epic's Feature manager, which runs the integration check, then calls
     `t3_feature_finish` with the PRs in merge order. The Project manager hears it.

   Either way, the Project manager can add a child feature later, such as a follow-up the Epic
   missed, with `t3_feature_start({ parentFeatureId })` (Phase 3).
3. As each part's PR merges into `staging`, the Project manager closes that part's issue. When the
   last one closes, it closes the parent issue and the milestone, and tells the bot.

### Guidelines for the Project manager's judgement

These go in the role's instructions. They are not hard rules.

**Task, feature or milestone**

- **Task:** one clear change in a few files. It has no open product or design question and needs no
  plan to review. Examples: a copy fix, a config bump, a small bug with an obvious cause.
- **Feature:** one reviewable PR that benefits from a plan, design, QA or review, or anything the
  person calls a feature.
- **Milestone:** more than one reviewable PR. Signs: several areas or surfaces (server, web,
  mobile), parts that depend on each other, a shared schema or contract other parts build on, or an
  integration check needed across parts.
- When unsure, start smaller. A task can be re-done as a feature, and a feature's Planner can propose
  a split, which the Planner instructions already ask for.

**Parallel or one at a time**

- Run in parallel when the pieces touch different files and packages, don't depend on each other,
  and can merge in any order.
- Run one after another, or stack with `baseBranch`, when they edit the same files, change a shared
  contract or schema, or add database migrations (migration numbers collide). Do the same when one
  needs another's API or decision.
- Before starting, look at what is running: open features and their branches (`t3_feature_list`),
  each branch's changed files (`git diff --name-only <base>...<branch>`), and open PRs. Prefer
  queuing over a likely merge conflict.
- There is no cap on how many run at once. The Project manager, and an Epic's Feature manager
  within its milestone, judge it from the work. Today's "Run at most two children at once" in
  `EPIC_INSTRUCTIONS` goes too (Phase 1).

**Answer or escalate**

- Answer when the brief, the issue and its comments, the repo's docs, or an earlier decision settle
  it. Record the answer as an issue comment so it survives a fresh session.
- Escalate to the bot or person for product or taste decisions, scope changes, conflicting
  requirements, credentials or money, and anything destructive or public, such as publishing,
  deleting data or force-pushing.

## Phases (each one PR)

### Phase 0: housekeeping (no code)

- Close #49 and PR #52 as superseded by lead-and-crew.
- Land #56 and task-issue-links first. Phases 2–3 build on both.

### Phase 1: rename "Project manager" → "Feature manager"

The role ID moves, so `role:project-manager` is free for the new role in Phase 2. Older client
builds don't need to keep working with the old ID (the person's call), so there is no
compatibility shim.

**Role ID migration** (one transaction, the same way `070_CrewRoles` re-pointed role IDs):

- `roles.id`: `role:project-manager` → `role:feature-manager`.
- `workflows.lead_role_id`, and any `crew_role_ids_json` entry, from the old ID to the new one.
- `crew_members.role_id` from the old ID to the new one.
- The retired engine's tables (`workflow_definition_*`, `feature_workflows`) are read by nothing,
  so leave them.

**Keep these stored IDs:**

- `bot-manager:<projectId>`: the Feature manager's member. Every feature-lead run ID is hashed from
  it, and the run ID is part of the lead's thread ID (`bot-run:feature-lead:<hash>`). Thread IDs are
  event-sourced and can't be renamed, and a new member ID would start a second lead the next time a
  feature starts or reopens. Comment it the way `bot-captain` already is ("predates the rename").
- `feature-lead:` run IDs.

**Contracts:**

- `PROJECT_MANAGER_ROLE_ID` becomes `FEATURE_MANAGER_ROLE_ID = "role:feature-manager"`.
  `PROJECT_MANAGER_ROLE_ID` comes back in Phase 2 for the new role, so Phase 1 must not leave the
  old name pointing at the old value.
- Fix the doc comment ("which Captain delegates to" is stale).

**Server:**

- In `DEFAULT_ROLES`, the name becomes "Feature manager".
- `PROJECT_MANAGER_INSTRUCTIONS` → `FEATURE_MANAGER_INSTRUCTIONS`, starting "You lead one feature's
  work…".
- `ensureProjectManager` → `ensureFeatureManager`, and `projectManagerMemberId` →
  `featureManagerMemberId` (value unchanged).
- `ensureProjectLead`'s special case follows the rename.
- In `headquartersTask`, `PROJECT_MANAGER_BRIEF` becomes a task brief ("You do one request in this
  worktree…"). The task child isn't a manager.
- `startRequest`'s task text names the Feature manager. It is reached only through `crewStart`, used
  by `client-runtime/state/roles.ts`; check whether that path is still live, and delete it if it
  isn't.

**Names and text (same migration):**

- Set `roles.name` to 'Feature manager' where the name is still 'Project manager'. Bump its revision
  so open editors re-read it.
- Make the same name change only for the project-level members, `bot-manager:*`. Feature-scoped
  members keep their names: a custom workflow can have today's role as a crew member, its lead's
  stored task names it "Project manager", and `FeatureService.crewMember` matches by current name
  or role ID, so renaming it would break `delegate_task({ crewMember: "Project manager" })` in a
  running feature. The migration test covers such a workflow.
- Replace the old default instructions with the new ones only where they are unchanged. This follows
  `095_LeadWorkflows`, which replaced the manager text the same way.
- Drop "Run at most two children at once" from the Epic workflow's instructions where they are
  unchanged.
- Edited names and instructions stay as the person left them.

**Open lead threads:**

- Running features keep their run snapshots (task text and instructions are run identity), so they
  keep working.
- Their thread titles still say "Project manager", which will be confusing once Phase 2 adds a real
  one. On startup, a one-time reconcile retitles lead threads of **open** features still titled
  "Project manager", through a thread title command with a fixed command ID per thread. That keeps
  projections consistent with events. Closed features keep their history.

**Clients:**

- Web: `LibraryPage` ("Add a Feature manager, Planner…"), `RoleEditor` comment, `CommandPalette`
  search terms (add "feature manager"), `FeaturesPage` empty state ("Its feature manager…").
- `client-runtime`: comments in `workGroups` and `crewRoster`. Test fixtures use the label
  "Project manager" as data; update them to the new name.
- Mobile: role and workflow panels (constant rename only).

**Docs:** `docs/user/bots.md`, `docs/user/features.md` and `docs/internals/crew.md`. The internals
doc says why `bot-manager:` keeps its old name.

**Evals:** this changes model-facing text, so run the `evals/mcp-tool-use` features cases per
`evals/README.md`. The repo `.env` had no `ANTHROPIC_API_KEY` last time. Rename the "project
manager" wording in `features.ndjson`.

**Risks**

- A missed reference to the old role ID leaves a workflow without a lead. Test that the migration
  re-points every workflow and member, and grep code, tests, evals and fixtures for
  `role:project-manager`.
- Phase 1 can ship alone. `ensureDefaults` creates missing roles by ID, and after Phase 1 its list
  has `role:feature-manager`, so nothing creates `role:project-manager` until Phase 2 does.
  Downgrading to an older server would recreate the old role as a second lead role.
- A person who renamed or edited the role keeps their edits.

### Phase 2: the Project manager's standing thread

**Role**

- A new default role "Project manager", id `role:project-manager` (freed in Phase 1). It holds the
  defaults every project's manager starts from.
- Its instructions hold the guidelines above.
- Grants: none ticked, like the other starter roles, so it gets every T3 toolkit an ordinary
  thread gets. Ticking toolkits limits it to those (`crewMcpCapabilities`). Not `crew.workflows`.
- **Crew tools need fixing first.** The `crew` capability, which every `crew_*` todo tool requires,
  comes only from a `crew.*` grant, and the only one is the bot-only `crew.workflows`
  (`crewMcpCapabilities.ts`). So today a feature lead can't call `crew_link_issue` or
  `crew_list_issues` either, although `CrewGatedToolkits` lists them for every crew thread. Fix:
  every crew thread (`isCrewThread`) gets `crew`, and `CrewGatedToolkits` keeps gating each tool.
  That also fixes Feature managers. Test it with real tool calls on a default lead and a default
  Project manager.
- It can't be a workflow's lead or crew. `createWorkflow`/`updateWorkflow` refuse it, and the web and
  mobile role pickers and `roleAvailabilityNote` skip it.

**Member and run**

- Member `project-manager:<projectId>`, made from the role on first use. Run
  `project-hq:<projectId>`, with the fixed thread `bot-run:project-hq:<projectId>`.

**Per-project settings** (the person's call: like a bot, but for one project)

- Each project's manager has its own instructions, model, access, tools and long-conversation
  setting. A member already carries instructions, model, runtime mode and `allowedTools`. Add a
  `long_conversation` column to `crew_members` and a member update operation in `CrewStore`.
- **Live settings.** A bot's HQ reads its bot's current grants (`runGrants` joins `bots` for
  `bot-hq:` runs) and model and mode (`syncHeadquarters`). Extend both to `project-hq:` runs, read
  from the member. Otherwise MCP authorization keeps the standing run's grants from when it was
  created. Feature and task runs keep their snapshots.
- New projects start from the role's defaults. Editing the role changes managers created later,
  the same way roles already behave.
- Where: a **Project manager** section in **Settings → Project** on web and desktop, and in the
  project settings on mobile. Saving re-syncs the standing thread. New instructions reach it on its
  next new session, as they do for a bot's headquarters.
- Contracts: a read of the project's manager settings, and an RPC
  `crew.updateProjectManager({ projectId, instructions, modelSelection, runtimeMode, allowedTools,
  longConversation })`, guarded in `CLIENT_GUARDED_RPC_SCOPES`.
- Generalize `ensureHeadquarters` (lock, restore, pin, `syncSettings`, fresh start, `startNewSession`)
  to "standing runs" for bots and projects, rather than copying it.
- The thread lives in the project, listed and pinned. Its workspace is the project checkout.

**Requests: `t3_project_send`, `t3_project_reply`, `t3_project_requests`**

Results come back long after the turn that took the request. A feature finishes in a later turn,
as a server report with no sender. So the link from request to requester is stored, not inferred
from a turn's messages.

- A `project_requests` table: `id` (R-n per project), `project_id`, `requester_thread_id`, `text`,
  `status` (open or done), `created_at` and `closed_at`. The request record links to its work only
  through its issue and the Project manager's own notes. The issue is the durable link, so there is
  no table joining requests to features.
- `t3_project_send({ projectId, message, requestId? })` ensures the Project manager exists, stores
  the request, and queues the message headed with its ID and requester. It returns the request ID
  and the thread link. A retry with the same `requestId` returns the same request. It is allowed for
  the HQ of the owning bot, or for a full-access caller.
- `t3_project_reply({ requestId, message, done? })`, Project manager only, posts to the requester
  thread with a fixed message ID per reply. `done: true` closes the request.
- `t3_project_requests({ status? })` lists the project's requests, so a fresh session finds what it
  still owes.
- Server notices (feature reports, merge notices) carry no request and never need a reply. The
  instructions say so.
- Fallback: when a Project manager turn that took a request message ends with no reply to that
  request, the server posts the turn's last message to the requester once, as an interim reply. Key
  it by request and run, so a restart doesn't repeat it.
- A matching client RPC lets the person send from the UI later; that isn't needed in this phase.

**Questions**

- A Feature manager's question reaches the Project manager through `FeatureReportReactor`, which
  already posts when a lead waits on the person. The Project manager answers with
  `t3_pending_request` (`list`, `read`, `respond`). Permission approvals stay with the person.
- An Epic child's question doesn't reach its parent's lead today. Extend `FeatureReportReactor`: a
  child's lead waiting on input notifies its parent's lead, the way a top-level lead notifies its
  requester. Test a top-level question and an Epic child's question.

**`t3_feature_list({ status?, parentFeatureId? })`** (moved here from Phase 3)

- It returns the project's features: lead thread, branch, base branch, parent, issue, PR and its
  state, requester, and the finished or report outcome. It reads what `board` already reads.
- The Project manager needs it after a fresh session and to judge overlap. Phase 2's instructions
  name only tools that ship in Phase 2.

**Work the Project manager starts**

- Features: the handler already sets the caller as requester for non-subagent threads, so feature
  reports land in the Project manager's thread.
- Tasks: `delegate_task` children of a Project manager are subagents in the same project. Today
  `listed` is set only for children in another project (`Orchestrator.ts`, about line 7922). Extend
  it: a child of a project HQ thread is `listed` too, so tasks show in the project list and on the
  board like features.

**Bot HQ text:** "Hand each request for a project to its Project manager with `t3_project_send`; it
picks task, feature or milestone and replies here. Start a feature or task in the project yourself
only when the person asks you to."

- An HQ run stores its task text when it is created, and a fresh start reuses that stored text. So
  changing `headquartersTask()` alone leaves existing installs on the old routing, even after
  `/new`. Add a migration like `098_ProjectHandoffs`. It replaces the stored HQ task text where it
  is still stock, and the stock parts of bot instructions that send work straight to tasks or
  features. Custom text stays.

**Reads:** `t3_project_list` and `t3_project_read` gain `managerThreadId` (null until created).

**Clients**

- The thread shows as a normal pinned row at the top of its project.
- Add **Open project manager** to the project's context menu, the command palette, and the long
  press on a mobile project row.
- Generalize **Start new session… / /new** from HQ threads to Project manager threads.
- `workGroups` treats it as a standalone row, not a feature.

**Docs:** user `bots.md` (bots → Project manager → features) and `features.md`. In internals
`crew.md`, add a short section on the two managers, why the Project manager is a standing thread,
and why requests are stored.

**Evals (new cases):**

- A bot sends a request to the Project manager (calls `t3_project_send`, not `t3_feature_start` or
  `delegate_task`).
- The Project manager picks a task for a small fix, a feature for a scoped change, and an Epic for a
  multi-surface request.
- The Project manager creates an issue before it starts work.

**Risks**

- The standing thread's context grows. Mitigate with the HQ's compaction or fresh-start, and keep
  facts in records (issues, features, issue comments).
- The Project manager has no read-only runtime mode, so "don't edit the checkout" is only guidance.
  Grant it nothing that writes code beyond what any thread has, and say so in the docs.
- Project managers on many projects mean idle threads, but an idle thread costs nothing until it gets
  a message.

### Phase 3: the backlog (issues and milestones)

**Issue links at start**

- `t3_feature_start` gains `issue` (URL, `#N` or `T-N`, the same shape as task-issue-links'
  `delegate_task` field).
- `t3_feature_start` gains `parentFeatureId`, allowed from that project's Project manager. Today a
  feature is a child only when a thread of its parent starts it. This lets the Project manager add a
  child to an Epic, such as a follow-up. The child reports to the parent's lead, as children already
  do.
- `FeatureService.create` links it inside the create transaction, before the lead starts. Today a
  link from the brief is forked and lands later.

**Todo tools**

- `crew_create_todo` gains `milestone` (title or number) and `parent` (issue number, as a GitHub
  sub-issue).
- New tools `crew_create_milestone({ title, description? })` and
  `crew_update_milestone({ milestone, state })`, through `IssueService` and the GitHub source-control
  provider.
- New tool `crew_comment_todo({ ref, body })`, so decisions survive a fresh session. This is
  optional; drop it if the Project manager keeps decisions on the issue some other way.

**Projects without GitHub:** tickets have no milestones, so big work is a parent feature plus a
parent ticket. Linear isn't covered by `IssueService` today; the reference parsing can come from
task-issue-links if it adds Linear.

**Docs:** user `features.md`, the issues section.

**Risk:** GitHub API scopes. Milestone and sub-issue writes need `issues: write`, the same scope
issue creation has today. Check it on a GitHub App token.

### Phase 4: close issues and milestones after merges into `staging`

**Merge notice**

- Derive it from persisted PR snapshot updates. `PullRequestSyncReactor` already refreshes every
  linked PR's snapshot, merges included. Linking a PR doesn't start a watch, and a watch can end
  early (settled thread, comment limit), so hooking `PullRequestWatchReactor` would miss merges.
  Watches stay optional and for reviews only.
- Send the notice to the **project's Project manager**, not the work's requester. An Epic child has
  no requester, and work a bot started directly has the bot's HQ as requester; the Project manager
  owns closing issues either way. The PR has to be linked to a thread of a feature or of a task in
  the project.
- Key it by host, repository and PR number, with a fixed message ID, so restarts and
  several threads linking the same PR don't repeat it. On startup, reconcile merged snapshots that
  have no notice yet.
- The notice names the feature, issue, milestone and target branch.

**Closing**

- The Project manager closes the issue (`crew_update_todo state: closed`, reason completed) with a
  comment linking the PR. A PR that targets `main` needs nothing: GitHub closes its "Closes #N"
  issues on merge.
- When every issue in a milestone is closed, it closes the parent issue and the milestone.
- On each fresh session it reconciles: features whose PR merged while their issue is still open.

**Why not close in the server**

The Project manager may keep an issue open on purpose, for example when a PR only covered part of
it. A visible state guards against a missed close: the board shows "merged, issue open".

**`main` merges:** when `staging` later merges into `main`, GitHub's auto-close of "Closes #N"
finds the issue already closed and does nothing.

**Risk:** none on host quota. The notice reads snapshots the sync reactor already keeps, and adds
no host calls.

### Phase 5: cleanup

- Bots keep both ways into a project: the HQ exception in `t3_feature_start` for owned projects, and
  `delegate_task` with `target.projectId`. The HQ instructions from Phase 2 make the Project manager
  the default, and the bot starts work directly only when the person asks. There is no server limit.
- A feature or task a bot starts directly still belongs to the project. Its requester is the bot's
  HQ, so the Project manager doesn't hear its reports. `t3_feature_list` still shows it, and merge
  notices go to the Project manager anyway (Phase 4).
- Delete what is dead: `bot-builder:<projectId>` and its delegation grant, which nothing reads since
  lead-and-crew, and `startRequest` and the `crewStart` RPC if Phase 1 found them unused.
- Lineage: #56 makes the Project manager's Lineage show the features it started. A bot's Lineage
  won't show the Project manager, because a sent message isn't a Lineage edge. A bot reaches it
  through the link in its reply and **Open project manager**. No new Lineage edge.

This phase is small; fold it into Phase 4 if that PR has room.

## Migration and compatibility

- **Stored IDs:** only the role ID moves (`role:project-manager` → `role:feature-manager`, Phase 1),
  and `role:project-manager` then names the new role. Member, run and thread IDs stay. New IDs are
  added for the Project manager (`project-manager:*` members and `project-hq:*` runs).
- **Running features:** unaffected. Their lead runs keep their task text, instructions and
  requester, and their member keeps its ID. Features started from a bot HQ before Phase 2 keep
  reporting to the HQ, which is fine.
- **Older clients:** not supported across the role ID change (the person's call). Builds made after
  Phase 1 use the new constants.
- **Remote and tunnel:** everything is server state and MCP, and no client-only state is involved.
  The Project manager thread is an ordinary thread, so every surface sees it.
- **Forks and custom workflows:** a workflow led by a custom role keeps its `bot-lead:` member. Only
  the role named "Project manager" is renamed.
- **This document:** AGENTS.md says not to commit plans. It is committed here because the person
  asked for it. Delete it once Phase 2 lands, or move what lasts into `docs/internals/crew.md`.

## Decisions

The person answered the first round of open questions on 2026-11-04:

1. **Role IDs.** Move the Feature manager to `role:feature-manager` and give `role:project-manager`
   to the new role. Older client builds don't need to keep working across the change.
2. **Who leads a milestone.** Either one, depending on the work. The Project manager leads it
   itself, starting the parts as features, or hands it to an Epic's Feature manager. Child features
   work under either.
3. **Bots starting work directly.** No server limit. By default a bot asks the project's Project
   manager, and it starts work directly only when the person asks.
4. **Closing issues.** The Project manager closes them after a merge into `staging`. GitHub closes
   them itself when a PR merges into `main`.
5. **One Project manager per project.** Yes. It is configured like a bot, but for one project:
   instructions, model and access per project.
6. **Parallel cap.** None. The Project manager, and a Feature manager within its own milestone,
   decide.
7. **Merging.** The person merges by default. The Project manager merges when the person asks it
   to.

## Open questions

- **Where the Project manager's settings live.** Recommendation: a section in **Settings → Project**,
  since it belongs to one project. The other option is a row per project under **Bots** on the
  rail, since it behaves like a bot.
- **Merging as standing permission.** Recommendation: the Project manager merges only when asked in
  the request, or when its per-project instructions say so (for example "merge to staging once
  review passes"). This needs no new setting.
