# Plan: a Project manager per project, and Feature managers per feature

Status: proposal, research only. Base: `origin/staging` at `19108ec227`.

## Summary

Today's "Project manager" leads one feature at a time, so it becomes the **Feature manager**. Only its
label and default text change; its stored IDs stay. A new **Project manager** gets one standing thread
per project, which lives as long as the project, like a bot's headquarters lives as long as the
bot. Bots hand every request for a project to that thread. The Project manager owns the backlog
(issues and milestones). It decides task, feature or milestone and when to run work in parallel. It
answers its Feature managers, and it closes issues and milestones once their pull requests merge
into `staging`.

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
  This plan routes bots through the Project manager instead (Phase 5).
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
         │ task   │ feature    │ milestone (Epic parent feature)
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
- The Project manager reports to the bot that sent the request (the reply reactor, Phase 2).

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

- It does not start features or tasks inside a project. That moves to the Project manager after the
  transition (Phase 5).

**Project manager**

May:

- read the project's code and git state, and inspect feature worktrees (`t3_worktree_status`);
- create, list, comment on and close issues, tickets and milestones;
- start tasks (`delegate_task` in a worktree) and features (`t3_feature_start`, including Epic
  features) in **its own project**;
- answer or redirect Feature managers (`t3_thread_send` to their lead threads);
- stop a feature;
- report to the bot, or ask the bot and person a question.

May not:

- edit, commit or push in the project checkout;
- merge pull requests (merging stays with the person or bot);
- hand work to a feature's crew directly (`crewMember` stays lead-only, as today);
- touch other projects;
- change bots, roles or workflows.

**Feature manager.** Its job is unchanged. It runs its workflow with its crew, asks for decisions,
and calls `t3_feature_finish`.

- Its questions now reach the Project manager first, because the Project manager is the feature's
  requester. That already works through `FeatureReportReactor`.
- It does not start sibling features (the Epic's Feature manager starts its own children). It does
  not close issues, and it does not talk to the bot.

**Crew.** Unchanged.

## End-to-end flows

### Simple work (one PR)

1. The person tells Captain: "Add a CSV export to the reports page in project X."
2. Captain calls `t3_project_send({ projectId: X, message })`. The server ensures X's Project manager
   thread exists, queues the message with Captain's HQ as sender, and returns the thread link. Captain
   links it and ends its turn.
3. The Project manager checks the backlog (`crew_list_issues`) for an existing issue. It finds none,
   so it creates one (`crew_create_todo as: issue`, or a ticket when the project isn't on GitHub).
4. It judges the work: one clear change, so a **task** or a **feature**.
   - A task: `delegate_task` in a worktree, with `issue: "#123"` (task-issue-links).
   - A feature: `t3_feature_start({ title, brief, issue: "#123" })`. The issue is linked when the
     feature is created, so every thread shows it from the start.
5. The Project manager checks the open features (`t3_feature_list`, Phase 3) and starts this one at
   once, because it doesn't overlap any of them.
6. The Feature manager runs Plan → Build → QA → Review.
   - When it needs a decision, it stops with the question. `FeatureReportReactor` posts the question
     to the Project manager, which answers from the brief, the issue or earlier decisions
     (`t3_thread_send`), or else asks Captain.
   - When it's done, the Builder opens the PR against `staging` with "Refs #123", and the Feature
     manager calls `t3_feature_finish`.
7. The Project manager hears the result. Its turn ends, and the reply reactor posts its summary to
   Captain's HQ.
8. The person, or a bot, merges the PR into `staging`. The server sees the merge and tells the
   Project manager once (Phase 4). The Project manager closes #123 with a comment linking the PR.

### Big work (a milestone)

1. Steps 1–3 as above. The Project manager judges this as **big**: several reviewable PRs, several
   areas, needs sequencing or an integration check.
2. It creates a GitHub **milestone** and a parent issue in it (Phase 3), then starts one **Epic**
   feature with `issue` set to the parent issue and the milestone named in the brief.
3. The Epic's Feature manager has its Planner propose the split, and asks for approval of it. The
   Project manager approves when the request already settles the split; otherwise it asks the bot.
4. For each child, the Epic's Feature manager:
   - creates an issue in the milestone, as a sub-issue of the parent;
   - starts the child with `t3_feature_start({ issue, baseBranch? })`.

   The Epic's Feature manager sequences children within the milestone. The Project manager sets the
   limits across milestones, such as how many builders run at once in the project, and tells the
   Epic's Feature manager.
5. Children report to the Epic's Feature manager. It runs the integration check, then calls
   `t3_feature_finish` with the PRs in merge order. The Project manager hears it.
6. As each child PR merges into `staging`, the Project manager closes that child's issue. When the
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
- Before starting, look at what is running: open features, their branches and changed files
  (`t3_worktree_status`), and open PRs. Prefer queuing over a likely merge conflict.
- Mind the machine: each Builder runs installs, checks and dev servers. Keep only a few builders
  running in a project at once, about two on a laptop, unless the person says otherwise.

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

The data keeps its IDs. Only names, default text and code identifiers change.

**Keep these stored IDs:**

- `role:project-manager`: workflows' `leadRoleId`, members' `role_id`, and older mobile builds that
  hard-code it as the default lead.
- `bot-manager:<projectId>`: the member every feature-lead run ID is hashed from.
- `feature-lead:` run IDs.

Reusing `role:project-manager` for the new role would silently give old data and old clients the
new meaning, and renaming the member would start a second lead for any feature started again. The
same precedent applies as `bot-captain` and `bot-manager:`, which "predate the Roles rename". Add a
one-line comment on the constant.

**Contracts:**

- `PROJECT_MANAGER_ROLE_ID` → `FEATURE_MANAGER_ROLE_ID` (value unchanged).
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

**Migration:**

- Set `roles.name` to 'Feature manager' where the id is `role:project-manager` and the name is
  still 'Project manager'. Bump its revision so open editors re-read it.
- Make the same name change for `crew_members` with that role and the old name.
- Replace the old default instructions with the new ones only where they are unchanged. This follows
  `095_LeadWorkflows`, which replaced the manager text the same way.
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
doc says the stored IDs keep the old name, and why.

**Evals:** this changes model-facing text, so run the `evals/mcp-tool-use` features cases per
`evals/README.md`. The repo `.env` had no `ANTHROPIC_API_KEY` last time. Rename the "project
manager" wording in `features.ndjson`.

**Risk:** low. It is labels and default text. A person who renamed or edited the role keeps their
edits.

### Phase 2: the Project manager's standing thread

**Role**

- A new default role "Project manager", id `role:project-hq`. That is a new ID, so nothing old picks
  it up.
- Its instructions hold the guidelines above.
- Grants: `orchestration` (`delegate_task`, `t3_thread_send`/`read`) and `pull-requests`. Not
  `crew.workflows`.
- It can't be a workflow's lead or crew. `createWorkflow`/`updateWorkflow` refuse it, and the web and
  mobile role pickers and `roleAvailabilityNote` skip it.

**Member and run**

- Member `project-hq:<projectId>` and run `project-hq:<projectId>`, with the fixed thread
  `bot-run:project-hq:<projectId>`, created on first use.
- Generalize `ensureHeadquarters` (lock, restore, pin, `syncSettings`, fresh start, `startNewSession`)
  to "standing runs" for bots and projects, rather than copying it.
- The thread lives in the project, listed and pinned. Its workspace is the project checkout.

**New MCP tool `t3_project_send({ projectId, message })`**

- It ensures the Project manager exists and queues the message with the caller as sender. It returns
  the thread ID and link.
- Allowed for the HQ of the owning bot, or for a full-access caller.
- A matching client RPC lets the person send from the UI later; that isn't needed in this phase.

**Reply reactor**

When a Project manager turn that consumed messages from other threads ends, the reactor posts the
Project manager's last message to each sender it didn't message itself during that turn. This
mirrors `FeatureReportReactor`, so a bot always hears back, and the Project manager needs no "reply"
tool.

- The reactor must use the message's `senderThreadId`.
- Write a test for a turn that batches messages from two bots.

**Work the Project manager starts**

- Features: the handler already sets the caller as requester for non-subagent threads, so feature
  reports land in the Project manager's thread.
- Tasks: `delegate_task` children of a Project manager are subagents in the same project. Today
  `listed` is set only for children in another project (`Orchestrator.ts`, about line 7922). Extend
  it: a child of a project HQ thread is `listed` too, so tasks show in the project list and on the
  board like features.

**Bot HQ text:** "Hand each request for a project to its Project manager with `t3_project_send`; it
picks task, feature or milestone and reports back here."

**Reads:** `t3_project_list` and `t3_project_read` gain `managerThreadId` (null until created).

**Clients**

- The thread shows as a normal pinned row at the top of its project.
- Add **Open project manager** to the project's context menu, the command palette, and the long
  press on a mobile project row.
- Generalize **Start new session… / /new** from HQ threads to Project manager threads.
- `workGroups` treats it as a standalone row, not a feature.

**Docs:** user `bots.md` (bots → Project manager → features) and `features.md`. In internals
`crew.md`, add a short section on the two managers, why the Project manager is a standing thread,
and the reply reactor.

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

### Phase 3: the backlog (issues, milestones, feature list)

**Issue links at start**

- `t3_feature_start` gains `issue` (URL, `#N` or `T-N`, the same shape as task-issue-links'
  `delegate_task` field).
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

**New read tool `t3_feature_list({ status?, parentFeatureId? })`**

- It returns the project's features: lead thread, branch, base branch, parent, issue, PR and its
  state, and the finished or report outcome. It reads what `board` already reads.
- The Project manager needs it after a fresh session and to judge overlap. Bots can use it too.

**Projects without GitHub:** tickets have no milestones, so big work is a parent feature plus a
parent ticket. Linear isn't covered by `IssueService` today; the reference parsing can come from
task-issue-links if it adds Linear.

**Docs:** user `features.md`, the issues section.

**Risk:** GitHub API scopes. Milestone and sub-issue writes need `issues: write`, the same scope
issue creation has today. Check it on a GitHub App token.

### Phase 4: close issues and milestones after merges into `staging`

**Merge notice**

- When a PR linked to a feature's lead thread, or to a task thread, becomes `merged`, notify that
  work's requester (the Project manager) once.
- Use a fixed message ID per PR so restarts don't repeat it.
- The notice names the feature, issue, milestone and target branch.
- Hook it into `PullRequestWatchReactor`'s merged transition.

**Watching**

- Verify that feature and task PRs are watched by default. `c047f66ad5` keeps tracking on listed
  handoff threads, but lead threads in the same project need checking.
- If they aren't, turn on a tracking-only watch when a feature's PR is linked.

**Closing**

- The Project manager closes the issue (`crew_update_todo state: closed`, reason completed) with a
  comment linking the PR.
- When every issue in a milestone is closed, it closes the parent issue and the milestone.
- On each fresh session it reconciles: features whose PR merged while their issue is still open.

**Why not close in the server**

The Project manager may keep an issue open on purpose, for example when a PR only covered part of
it. A visible state guards against a missed close: the board shows "merged, issue open".

**`main` merges:** when `staging` later merges into `main`, GitHub's auto-close of "Closes #N"
finds the issue already closed and does nothing.

**Risk:** PR-watch quota. The watch sweeps every 2 minutes, and more watched PRs mean more host
calls. Use the existing fingerprint path.

### Phase 5: bots go through Project managers; cleanup

- Remove the HQ exception in `t3_feature_start` that lets a bot target an owned project. Bots use
  `t3_project_send`.
- Change `delegate_task` from an HQ into an owned project so it is refused with a hint to
  `t3_project_send`, or keep it as an escape hatch (open question 3).
- Delete what is dead: `bot-builder:<projectId>` and its delegation grant, which nothing reads since
  lead-and-crew, and `startRequest` and the `crewStart` RPC if Phase 1 found them unused.
- #56's Lineage on a bot HQ then shows the Project manager threads it messaged. The Project
  manager's Lineage shows its features and tasks.

## Migration and compatibility

- **Stored IDs:** none change (see Phase 1). New IDs are only added (`role:project-hq` and
  `project-hq:*`).
- **Running features:** unaffected. Their lead runs keep their task text, instructions and
  requester. Features started from a bot HQ before Phase 2 keep reporting to the HQ, which is fine.
- **Older clients:** they see the new role as an ordinary role. An old mobile build could offer it as
  a workflow lead, and the server refuses that. Old clients don't know `t3_project_send` (MCP is
  server-side) or the `managerThreadId` field (optional, ignored).
- **Remote and tunnel:** everything is server state and MCP, and no client-only state is involved.
  The Project manager thread is an ordinary thread, so every surface sees it.
- **Forks and custom workflows:** a workflow led by a custom role keeps its `bot-lead:` member. Only
  the role named "Project manager" is renamed.
- **This document:** AGENTS.md says not to commit plans. It is committed here because the person
  asked for it. Delete it once Phase 2 lands, or move what lasts into `docs/internals/crew.md`.

## Open questions for the person

1. **The new role's ID.** Recommendation: `role:project-hq`, keeping `role:project-manager` as the
   Feature manager's stored ID. The other option is to migrate `role:project-manager` →
   `role:feature-manager` and reuse `role:project-manager` for the new role. That reads better in
   code, but older mobile builds and existing data would silently give the old ID its new meaning.
2. **Who leads a milestone.** Recommendation: keep the Epic's Feature manager as the milestone's
   lead. It splits, sequences children and runs the integration check, and the Project manager starts
   the Epic and sets limits across the project. This is tested and keeps a milestone's chatter out of
   the long-lived thread. The other option is for the Project manager to start and sequence children
   itself, with the parent feature as a grouping record only. That gives it one less hop but makes its
   context much busier.
3. **Can bots still start work in a project directly?** Recommendation: no, after Phase 5. Every
   request goes through the Project manager, so the backlog and parallelism stay in one place. The
   other option is to keep `delegate_task` into owned projects as an escape hatch for emergencies.
4. **Who closes issues after a merge.** Recommendation: the Project manager, prompted by the merge
   notice (Phase 4), with "merged, issue open" visible on the board. The other option is for the
   server to close the linked issue automatically on merge. That is more reliable, but it closes
   issues the PR only partly covered.
5. **Should every project get a Project manager?** Recommendation: create it on first use, the way
   `bot-manager:` members are created today, with no setting. An idle thread costs nothing. Add a
   per-project off switch only if someone asks.
6. **Parallel cap.** Recommendation: a guideline of about two active builders per project in the
   instructions, not a server limit. The person can change it in the role's instructions.
7. **Who merges PRs.** Recommendation: the person, or the bot when the person asks. The Project
   manager doesn't merge.
