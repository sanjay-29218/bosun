---
name: sync-t3code
description: Merge upstream T3 Code (pingdotgg/t3code main) into Bosun's main so Bosun keeps building on the latest upstream. Use for the daily upstream sync, "pull in T3 Code", "update from t3code", or resolving conflicts between Bosun features and upstream changes.
---

# Sync upstream T3 Code into Bosun

The goal of a sync is to take every upstream change while keeping every Bosun feature
working: no behavior lost on either side, no refactors, no fixes beyond what the merge
needs. Sync often (daily); small merges have small conflicts. Remotes, branding scope and
the "keep Bosun edits localized" rule live in [BOSUN.md](../../../BOSUN.md).

## What Bosun is

Bosun is an agentic software factory built on T3 Code, which it tracks as upstream. T3 Code
gives a person threads, providers, checkpoints and the web/desktop/mobile clients. Bosun adds
a crew that works through those threads: a person asks a project's **bot**, the bot hands
the work to the project's **manager**, and **crew members** take a **feature** through a
**workflow** of stages (plan, design, build, test, review). One feature is one worktree, one
branch and one PR.

Vocabulary (stored ids such as `bot-captain`, `bot-manager:`, `feature-bot:` and `bot-run:`
predate renames and stay on purpose, because saved data references them):

- **Bot:** top level, owns projects (`project.botId`). Captain is the default bot. Each bot
  has a headquarters thread.
- **Role:** a global, reusable job description (Planner, Builder, Reviewer, …).
- **Crew member:** a role instantiated for one feature, plus one manager per project.
- **Run / handoff:** a run is one thread doing one task; a handoff is a durable request
  between runs. See [docs/internals/crew.md](../../../docs/internals/crew.md).
- **Workflow:** an environment-wide library of stage graphs (the roles are the crew recipe).
- **Feature:** a brief a crew takes through a workflow, shown on the Board.

### Bosun-only areas

Upstream never touches these, so they rarely conflict. What breaks is where they hook into
upstream code. When a conflict touches a hook, keep Bosun's side working. Paths are short
for `apps/<app>/src/...` and `packages/<package>/src/...`.

| Area               | Bosun-only code                                                                                                                                         | Hooks into upstream                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bots               | `server/src/bots`, `contracts/src/bots.ts`, `web/src/components/bots`, `/bots`, Settings → Bots                                                         | project ownership in `ProjectService`, thread action menus (a headquarters can be archived, never deleted), sidebar rail                                                |
| Crew, roles        | `server/src/crew`, `contracts/src/crew.ts`, `web/src/components/crew`, `mobile/src/features/crew`, `client-runtime` `crewStage` and `crewMessageOrigin` | Orchestrator `thread.crew-stage.set` plus thread `crew`/`feature`/`crewRequest` fields, the crew label in the mobile `ThreadFeed`, MCP tool grants (`CREW_TOOL_GRANTS`) |
| Workflows, Library | `server/src/workflows`, `contracts/src/workflow.ts`, `web/src/components/{workflows,library}`, `/library`, Settings → Workflows and Roles               | command palette, settings search and nav                                                                                                                                |
| Features, Board    | `server/src/features`, `contracts/src/features.ts`, `web/src/components/features`, `/board`                                                             | thread details card (`ThreadFeatureRow`), thread menus (feature lifecycle), sidebar list/board toggle, `mainAppLocation`                                                |
| Tickets, issues    | `server/src/{tickets,issues}`, `contracts/src/{tickets,issues}.ts`                                                                                      | `GitHubSourceControlProvider`                                                                                                                                           |
| Automations        | `web/src/components/automations`, `/automations` (`/settings/scheduled-tasks` only redirects there)                                                     | `ScheduledTaskService`: bot tasks run in the bot's headquarters (`botId`, `deleteForBot`, `connectBotHeadquarters`); mobile `SettingsScheduledTasksRouteScreen`         |
| MCP tools          | `server/src/mcp/toolkits/{bots,crew,features,workflows}`                                                                                                | tool list size in `agentContextBudget.json`                                                                                                                             |
| Transport          | `server/src/bosunWsHandlers.ts`, Bosun RPCs in `contracts/src/rpc.ts`                                                                                   | `rpc.ts` is the biggest Bosun edit to an upstream file                                                                                                                  |
| Storage            | `persistence/BosunMigrations.ts` with its own `bosun_sql_migrations` ledger                                                                             | `Migrations.ts` (upstream's ledger)                                                                                                                                     |

Upstream files Bosun edits most (expect conflicts here): `contracts/src/rpc.ts`,
`web` `CommandPalette.tsx`, `Sidebar.tsx`, `sidebar/mainAppLocation.ts`, `ChatView.tsx`,
`threadActionMenu.logic.ts`, `uiStateStore.ts`, `server` `ScheduledTaskService.ts` and
`ProjectService.ts`, `mobile` `thread-list-v2-items.tsx`, `ThreadNavigationSidebar.tsx` and
`HomeRouteScreen.tsx`, and `README.md`. For the current list, run
`git diff --numstat $(git merge-base origin/main t3code/main) origin/main | sort -rn | head -30`.

Migration numbers overlap on purpose: upstream and Bosun both have files numbered 055 and up
in `persistence/Migrations/`, kept apart by the two ledgers. New upstream migrations belong
only in `Migrations.ts`; Bosun's only in `BosunMigrations.ts`, at the next free Bosun number.

## Rules

- **Merge, never rebase.** `main` is published, and other branches build on it. Merge
  `t3code/main` into a sync branch and fast-forward `origin/main` to it. Never force-push.
- **Work in a temporary worktree** outside the repo. Never in the main checkout or another
  thread's worktree; either may be in use.
- Never push to `t3code` (its push URL is disabled on purpose).
- Follow AGENTS.md: no dev servers, no browsers, no repo-wide checks, never touch
  `~/.t3/userdata` or `~/.bosun`.
- Don't merge into `crew/*`, `bots2/*` or feature branches. They pick up the new `main`
  themselves.

## Steps

1. Fetch and check whether there is anything to do:
   ```sh
   git fetch t3code main && git fetch origin main
   git merge-base --is-ancestor t3code/main origin/main && echo "already up to date"
   git rev-list --count origin/main..t3code/main   # upstream commits to merge
   ```
   Also check that no other sync is in flight: `git worktree list | grep -i sync`. If
   another thread is syncing, stop and say so.
2. Create the worktree and merge:
   ```sh
   D=/tmp/bosun-sync-$(date +%Y%m%d)
   git worktree add "$D" origin/main -B sync/t3code-main
   cd "$D" && git merge --no-ff t3code/main -m "chore: merge T3 Code main (YYYY-MM-DD)"
   ```
3. Install with `pnpm install --frozen-lockfile` (see Tooling gotchas if pnpm fails).
4. Resolve conflicts (below). List them with `git diff --name-only --diff-filter=U`.
5. Verify (below), then commit. The commit hooks run fmt, lint and knip.
6. Push: `git fetch origin main`, confirm `git merge-base --is-ancestor origin/main HEAD`,
   then `git push origin sync/t3code-main:main`. If `main` moved, `git merge origin/main`
   into the sync branch (don't rebase), rerun the tests, then push.
7. Clean up: `git worktree remove --force "$D"` and `git branch -D sync/t3code-main`.

## Resolving conflicts

Before each file, look at what each side meant to do, not just the hunk:

```sh
BASE=$(git merge-base origin/main t3code/main)
git diff $BASE origin/main -- <file>      # Bosun's intent
git log --oneline $BASE..t3code/main -- <file>
git diff $BASE t3code/main -- <file>      # upstream's intent
git checkout --conflict=zdiff3 -- <file>  # re-show hunks with the base version
```

- **Both added something** (a switch case, an interface method, a mock entry, a menu
  action, a settings entry): keep both. This is most conflicts.
- **Branding:** keep Bosun's product name, app ids and descriptions; rebrand new upstream
  user-facing "T3 Code" strings to "Bosun" and update their test assertions. Leave internal
  identifiers alone: `@t3tools/*` packages, `T3CODE_*` env vars, the `t3` bin.
- **Bosun moved or replaced an upstream file** (for example, scheduled tasks moved out of
  Settings into `components/automations/`): git's rename detection can splice upstream's
  whole old file into Bosun's. Take Bosun's file (`git checkout --ours`), then list the
  upstream commits to the _old_ path (`git log $BASE..t3code/main -- <old path>`) and port
  each one's intent into Bosun's new home by hand. Upstream tests for the old file don't
  carry over; note that in the report.
- **Upstream reworked code Bosun extends** (for example, a dispatch that gained retries):
  build on upstream's new shape and route Bosun's extra path through it, so Bosun's
  feature gets upstream's fix too.
- **Upstream test assumes behavior Bosun deliberately changed** (for example, a menu Bosun
  made async): adapt the test minimally (await a `Deferred`, never sleep) and note it. Don't
  change Bosun's code to satisfy it.
- **`apps/server/src/provider/agentContextBudget.json`:** the new value is
  base + Bosun's delta + upstream's delta. Compute it from the three versions, then confirm
  with `AgentContextBudget.test.ts`. Don't just take the measured number blindly.

After a "keep both" edit, check the seams, which compile-free test runs miss:

- Duplicate imports (both sides added the same name).
- Joined object or array entries missing a `},` / `{` between them.
- Both sides' tests closed properly (`}).pipe(...)` / `);`).
- Route and settings tables: new upstream settings paths need entries in Bosun's tables
  too (`SINGLE_ENVIRONMENT_PATHS`, `SETTINGS_CATEGORY_SCOPES`). Routes Bosun removed
  (redirect-only routes like `/settings/scheduled-tasks`) stay out of `SettingsPath`.

### Stop and report instead of resolving

Run `git merge --abort`, push nothing, and report the files with a sentence each when:

- upstream deleted or rewrote a subsystem Bosun builds on, and porting isn't mechanical;
- both sides changed the same persisted event, command or contract shape (old events must
  still decode);
- both sides edited the same migration, or upstream changed the migration runner.
  Bosun's migrations have their own ledger (`BosunMigrations.ts`); keep them out of
  upstream's list;
- a resolution would drop either side's behavior;
- a test fails and you can't explain it as merge mechanics.

## Verify

Run checks on what you touched, not the repo:

- Tests beside every resolved file, plus tests that cover the merged symbols
  (`grep -rl <symbol> apps packages --include='*.test.ts*'`). Always include
  `apps/server/src/provider/AgentContextBudget.test.ts` and, if persistence changed,
  `apps/server/src/persistence/Migrations.test.ts`.
  `./node_modules/.bin/vp test run <files>`
- Typecheck each touched package from its directory:
  `../../node_modules/.bin/tsc --noEmit` in `apps/server`, `apps/web`, `apps/mobile`. A
  bad seam often shows up only here (duplicate keys, wrong ids).
- `./node_modules/.bin/vp fmt --check <files>` and `./node_modules/.bin/vp lint <files>`.
- When a test fails, run the same test on pristine `t3code/main` in a second worktree.
  Failures that also happen upstream (host-dependent tests, for example Windows payloads on
  macOS) are fine; note them. Any new failure blocks the push.

## Tooling gotchas

- Use the sync worktree's own `./node_modules/.bin/vp`; another checkout's `vp` breaks
  vitest. `vp` isn't on the agent's PATH.
- If pnpm fails with `Failed to switch pnpm ... ENOEXEC`, the pnpm version pinned in
  `package.json` (`packageManager`) is only half-installed. Run its launcher directly
  instead of changing the user's setup:
  `node ~/Library/pnpm/.tools/pnpm/<version>/node_modules/pnpm/bin/pnpm.mjs install --frozen-lockfile`.
- The shell is zsh: write `git show "${ref}:path"` (in `$ref:path`, zsh reads `:a` as a
  modifier), and quote globs, since an unmatched glob is an error.
- `export _ZO_DOCTOR=0` silences zoxide noise on every `cd`.

## Report

- The number of upstream commits merged, and a few notable ones from their titles.
- Each conflicted file: what each side did and how you combined them.
- Anything ported by hand, upstream tests that didn't carry over, and tests you adapted.
- The tests, typechecks and lint you ran, with results and any upstream-only failures.
- The pushed SHA, or why you stopped. Note that `crew/*` and `bots2/*` can pick up `main`.
