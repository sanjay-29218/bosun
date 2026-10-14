# Bots, workflows and roles

A **bot** (Captain, Social, Finance…) owns projects and runs their work. A **workflow** takes a
feature through stages, and each stage runs as a **role**. All three belong to an environment and
are shared by every project on it. Each has its own page in Settings; pick the environment at the
top of the page.

## Bots

**Settings → Bots** lists the environment's bots in rail order. Every environment starts with
**Captain**, which owns projects that were never given to another bot.

Use **Add bot** for another bot. A bot has a name, a robot avatar you build from parts (or
**Shuffle**), a color, instructions, tools, a default model and the workflow its features start
with. **Act** lets it work on its own; **Ask first** asks before changes. Use the **⋯** menu to
edit a bot, move it up or down, or delete it.

**Projects** on the same page shows which bot owns each project. Pick another bot to move a
project; work that already started keeps running as the bot that started it. You can also change
a project's bot in **Settings → Project → Bot**. A bot can only be deleted once it owns no
projects, and Captain can't be deleted.

Each bot has one **headquarters** thread where it oversees every project it owns. Open it from the
bot at the top of the sidebar (or the thread list on mobile), by clicking the selected bot in the
rail again, or with **Open …'s thread** in the command palette. A dot there shows when it's
working or needs you. From there the bot can list its projects, hand work to any project's
manager, and answer their questions. With **Create projects** ticked in its tools, it can also start
projects from a name or by cloning a Git URL. Features report to the headquarters too. A feature's
own threads, its stage thread and its project manager's thread, carry a tag with the feature's name.

The headquarters follows the bot's current tools, model and **Act** / **Ask first** setting. Its
instructions are the ones it started with; to give it new ones, delete the thread and open it
again. Opening it also brings back a deleted or archived headquarters.

### The bot rail

With two or more bots, or two connected environments, a rail of bot avatars sits at the left edge
of the window. Pick a bot to see only its projects in the sidebar, Needs you and the board; the
List / Board choice is remembered per bot. A badge on an avatar counts the threads waiting on you
there. Switch bots with **Cmd+1–9** (**Ctrl+1–9** on Windows and Linux) on desktop, or **Switch
to …** in the command palette. With several bots, jumping to a thread moves to **Ctrl+Cmd+1–9**
(**Ctrl+Alt+1–9**).

Bots with the same name on different environments share one avatar, and new projects go to the
bot you're looking at. **+** adds a bot, and the pencil on the bot at the top of the sidebar edits
it. The server icon
filters the rail and sidebar to some environments; pick **All environments** to show every one
again. To move a project, right-click it in the sidebar's project picker and choose **Move to
bot**.

## Workflows

**Settings → Workflows** lists the environment's workflows. Use **Add starter workflow** for
Feature delivery, or **New workflow** for a one-stage workflow to build on (both add the starter
roles too if they're missing), then **Edit** to open a workflow's page.

- **Stages** run in order from the first stage. Each stage runs as a crew role, has a task, and
  can write files such as `plan.md`. Its last line says what it gets in its handoff: every earlier
  output by default, or only the files and changes you pick. **Approve …** switches make the
  feature wait for your approval after that stage. A stage can be removed once nothing starts at
  it or routes to it.
- **Routes** say where each outcome goes next, for example back to Build when Review requests
  changes. Give a route a number to stop the feature at **Your call** after it has been taken that
  many times. Questions go to the project manager first, then to you. A failed stage retries the number of
  times you set (empty uses **Retries before a stage fails** in Roles), then pauses and notifies you.
- **Canvas** and **Form** switch between two views of the same workflow. To add a stage on the
  canvas, drag a role from the panel beside it onto the canvas and describe its task. Drag from
  an outcome on a stage's right edge to another stage to route it there, and select a stage or
  route to edit it in the panel beside the canvas. The expand button gives the canvas the whole
  settings page; **Esc** shrinks it back. Where you place stages is saved with the workflow.
  Narrow screens always show the form.
- **Publish vN** saves a new version; **Discard** drops your edits. Features that already started
  keep the version they began with. Use the **⋯** menu to duplicate or delete a workflow; deleting waits until no unfinished feature runs on it and no bot starts its features with it.

Workflows record the version of each role they use. After you edit or turn off a role in Roles, the
workflow shows that it changed, and new features can't start on it until you publish a new version.

## Roles

**Settings → Roles** holds the roles workflow stages run as, and limits on running agents.

Use **Add the starter roles** for a Project manager, Planner, Designer, Builder, QA Tester and
Reviewer. Each role has instructions, crew tools and a default model. **Act** lets it work on its
own; **Ask first** asks before changes. Use **Add role** for another role, and the **⋯** menu to
edit a role or turn it off. Only roles with **Workflow stages can use this role** switched on can
be picked for a stage. Each project gets its own project manager the first time a request or
feature needs one; editing a role changes the members made from it later, not existing ones.

**Limits** are environment-wide:

- **Agents running at once** (default 4). Further stage threads wait as Queued. Threads you start
  yourself are never counted or queued.
- **Per provider** caps one provider, so its rate limit doesn't stall every feature. Empty means no
  cap.
- **Retries before a stage fails** (default 1), for workflows that don't set their own.

Editing bots, workflows and roles is available on web and desktop. **Settings → Project → Crew
activity** still lets you give the project's bot a task and answer, cancel or retry its requests.

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
your note. **Settings → Workflows** shows each workflow's stages, **Settings → Roles** edits
roles, and **Settings → Project** shows and changes the project's bot.

The project checkout and provider account belong to the connected environment shown in Settings.
If that environment is offline, reconnect it to see current crew status or send an action.
