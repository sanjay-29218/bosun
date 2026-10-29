# Bots, workflows and roles

A **bot** (Captain, Social, Finance…) owns projects and runs their work. A **workflow** takes a
feature through stages, and each stage runs as a **role**. All three belong to an environment and
are shared by every project on it. Bots and the Library each have a place on the rail.

## Bots

**Bots** on the rail lists each environment's bots in rail order; drag one to reorder them. Every
environment starts with **Captain**, which owns projects that were never given to another bot.
A new Captain starts with **Full access** and every tool. The pencil beside the bot's name at the
top of the sidebar opens its page too.

Use **+ New** for another bot. A bot has a name, a robot avatar you build from parts (or
**Shuffle**), a color, instructions, tools, a default model and the workflow its features start
with. **Access** sets how freely it works, with the same levels as the composer: **Supervised** asks before commands and file changes, up to **Full access**. Changes apply when you
**Save**. A bot's threads, like a role's, are offered only the crew tools its ticked tools
allow; threads you start yourself get none of them. **Open thread** opens its headquarters, and the **⋯** menu moves it up or down or deletes it.

A bot's **Projects** tab lists the projects it owns. Move one to another bot, or bring one over;
work that already started keeps running as the bot that started it. You can also change a
project's bot in **Settings → Project → Bot**. A bot can only be deleted once it owns no projects,
and Captain can't be deleted. Deleting a bot also deletes the automations that run as it.

**Settings → Bots** holds what applies to every bot: the **Limits** below.

Each bot has one **headquarters** thread where it oversees every project it owns. Open it from the
bot at the top of the sidebar (or the thread list on mobile), by clicking the selected bot in the
rail again, or with **Open …'s thread** in the command palette. A dot there shows when it's
working or needs you. From there the bot can list its projects, hand work to any project's
manager, and answer their questions. Work it hands off runs with the model and **Access** its
own thread has, unless it names another model, and so does whatever that work hands off in turn.
Workflow stages are the exception: each runs with its role's model and **Access**. With **Create projects** ticked in its tools, it can also start
projects from a name or by cloning a Git URL. With **Manage workflows**, which Captain has from the
start, it can create and edit workflows and roles when you ask, such as "add a QA stage to Feature
delivery"; they show up in Settings like ones you made. It can also start a feature in one of its
projects, on the workflow you name or its default one, just as you would from the composer. Features
report to the headquarters too. A feature's
own threads, its stage thread and its project manager's thread, carry a tag with the feature's name.

The headquarters follows the bot's current tools, model and **Access**. Its
instructions are the ones it started with; to give it new ones, delete the thread and open it
again. Opening it also brings back a deleted or archived headquarters.

### The bot rail

A rail of bot avatars sits at the left edge of the window, with **Usage** and **Settings** at its
bottom. With two or more bots, pick a bot to see only its projects in the sidebar, Needs you and
the board; the List / Board choice is remembered per bot. **All bots**, at the top of the rail, shows every bot's
threads again. Switch bots with **Cmd+1–9** (**Ctrl+1–9** on Windows and Linux) on desktop, or
**Switch to …** and **Show All bots** in the command palette. **Bots: Show All Bots** has no
shortcut until you give it one in **Settings → Keybindings**. With several bots, jumping to a
thread moves to **Ctrl+Cmd+1–9** (**Ctrl+Alt+1–9**). On mobile, the bot button in the thread
list header lists **All bots** first.

Each rail icon shows one thing at a time: an amber count of threads waiting on you, a red dot when
a run failed, a blue dot on its lower corner while a bot works, or a plain dot when a run finished
that you haven't opened. Bots other than the one you picked are dimmed until you point at them.
All bots shows the same across every bot.

Below the bots, the rail's places swap what the sidebar lists. **Bots** lists your bots to add and
edit, as above. **Automations** lists your
scheduled tasks by bot, with each one's schedule and next run; pick one to edit it and see its
recent runs. A task can also run as a bot: see [Scheduled tasks](project-settings.md#scheduled-tasks). A red dot on Automations means a run failed and you haven't opened that task since.
**Library** lists your workflows, each with its stages in order, and your roles; pick one to edit
it. The pull request icon opens **Pull requests**. Pick a bot to go back to its threads. On a server without bots, open Bots, Automations and Library
from the bottom of the sidebar, or **Open bots**, **Open automations** and **Open library** in the command palette; on mobile, they're the last entries in the bot button's
menu.

Bots with the same name on different environments share one avatar, and new projects go to the
bot you're looking at, or to Captain from All bots. **+** adds a bot, and the pencil on the bot at the top of the sidebar edits
it. The server icon
filters the rail and sidebar to some environments; pick **All environments** to show every one
again. To move a project, right-click it in the sidebar's project picker and choose **Move to
bot**.

## Workflows

The **Library** lists every connected environment's workflows; pick one to open its editor. **+
New** beside Workflows asks for a name and starts a one-stage workflow to build on, or offers
**Add Feature delivery**. Both add the starter roles too if they're missing. With more than one
environment, pick where the new workflow goes first. A dot on a workflow means a role it uses
changed and it needs a new version.

- **Stages** run in order from the first stage; **Start here** in a stage's menu changes which one that is. Each stage has a name, runs as a crew role, has a
  task, and reports one of its outcomes. Under **Advanced** it can write files such as `plan.md`
  and pick what it gets in its handoff: every earlier output by default, or only the files and
  changes you pick. **Needs your approval** makes the feature wait for you after that stage. A stage can be removed once nothing starts at
  it or routes to it.
- **Routes**, listed under each stage, say where each outcome goes next, for example back to Build
  when Review requests changes. A route back to an earlier stage can have a limit: after it has
  been taken that many times, the feature stops at **Your call**. Questions go to the project manager first, then to you. A failed stage retries the
  number of times set under **Settings** (empty uses **Retries before a stage fails** in
  **Settings → Bots**), then pauses and notifies you.
- **Canvas** and **Form** switch between two views of the same workflow. To add a stage on the
  canvas, drag a role from the panel beside it onto the canvas and describe its task. Drag from
  an outcome on a stage's right edge to another stage to route it there, and select a stage or
  route to edit it in the panel beside the canvas. Routes back to an earlier stage are dashed and
  run below the stages; point at an outcome or route to pick out its path. The expand button gives
  the canvas the whole page; **Esc** shrinks it back. Where you place stages is saved with
  the workflow, and **Arrange** lines them up left to right again.
  Narrow screens always show the form.
- **Publish** appears at the top of the page once you change something and saves a new version; **Discard** drops your edits. Features that already started
  keep the version they began with. Use the **⋯** menu to duplicate or delete a workflow; deleting waits until no unfinished feature runs on it and no bot starts its features with it.

Workflows record the version of each role they use. After you edit or turn off a role in Roles, the
workflow shows that it changed, and new features can't start on it until you publish a new version.

## Roles

The **Library**'s Roles are what workflow stages run as. **+ New** beside Roles adds one, and
offers **Add the starter roles** for a Project manager, Planner, Designer, Builder, QA Tester and
Reviewer when an environment doesn't have them yet. The Builder can split its work into subagents that run at the same time; give any role
**Threads and subagents** to let it do the same. Each role has instructions, crew tools and a default model. **Access** sets how freely its
threads work, from **Supervised** to **Full access**. Pick a role to edit it. Roles aren't deleted: the **On** switch at the top turns one off
to retire it, and back on. Only roles with **Available in workflows** switched on can be picked
for a stage. Each project gets its own project manager the first time a request or
feature needs one; editing a role changes the members made from it later, not existing ones.

**Limits**, at the bottom of **Settings → Bots**, are environment-wide:

- **Agents running at once** (default 4). Further stage threads wait as Queued. Threads you start
  yourself are never counted or queued.
- **Per provider** caps one provider, so its rate limit doesn't stall every feature. Empty means no
  cap.
- **Retries before a stage fails** (default 1), for workflows that don't set their own.

Editing bots, workflows and roles is available on web and desktop. **Settings → Project → Crew
activity** still lets you give the project's bot a task and answer, cancel or retry its requests.

## Feature threads

A feature shows in the sidebar as one row, titled by the feature. A strip under the title shows
its stages: finished, the current one in its state's color, and the ones still to come. Clicking
the row opens the stage waiting on you if there is one, otherwise the feature's lead (its project
manager's thread). A thread of the feature that waits on you also shows under the row. Right-click
the row for **Feature** → **Pause**, **Resume**, **Cancel** or **Reopen**.

Inside any of the feature's threads:

- The last part of the title bar names where you are (**Lead**, or a stage such as **Build**) and
  switches between the lead and each stage.
- The thread's details panel shows where the feature stands. Unfold it to see the lead and every
  stage with its role and state, and jump to any of them.
- The **Crew** tab in the right panel lists the same crew in full: retries under each stage,
  helpers a stage asked for, what waits on you with **Approve** and a way to that stage, plus the
  feature's outputs, branch and controls.
- While a stage waits on you, the lead's thread shows a banner with **Open** and, for an approval,
  **Approve**.

Subagents aren't part of the crew list; they stay inside the thread that started them.

Work a bot hands on does the same: a request to a project's manager and the threads it hands to
its builder, including retries, share one row titled by the request, with the crew members it went
through in place of a strip. Its first role is its lead. On mobile, the count on the row opens a
menu of the crew.

## Features from threads

To turn a thread into a feature, choose **Make it a feature…** from the thread's ⋯ menu or the
command palette. On mobile, choose **Workflow…** from the thread's menu. Pick a workflow and the stage
this thread already covers. Earlier stages are marked skipped, and the thread keeps its history,
branch and worktree. If the thread's last turn finished, its last reply is handed to the next
stage, after approval if this stage has a gate. Otherwise this happens when the turn ends.
**Detach from workflow** in a stage thread's menu turns it back into a plain thread and cancels
the rest of the feature. Reopening the feature reattaches the thread.

The mobile app runs features but does not edit workflows. The bot button in the thread list
header opens the bot's headquarters. With more than one bot it also switches bots, and its menu
shows how many threads wait on you under each one. The List / Board button beside it flips to the bot's features, with the ones
waiting on you first. Choose a workflow in the new task sheet to start a feature with your prompt
as its brief; it starts on the bot's default workflow. In a stage thread, the card above the
composer approves, retries or recovers the stage, and the composer text goes with the action as
your note. **Library** in the bot button's menu opens **Settings → Workflows**, which shows each
workflow's stages and links to **Settings → Roles** to edit roles. **Settings → Project** shows and
changes the project's bot.

The project checkout and provider account belong to the connected environment shown in Settings.
If that environment is offline, reconnect it to see current crew status or send an action.
