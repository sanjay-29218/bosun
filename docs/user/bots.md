# Bots and roles

A **bot** (Captain, Social, Finance…) owns projects and runs their work. A **role** is a kind of
crew member, such as Planner or Builder, that a feature's lead can hand work to. Both belong to an
environment and are shared by every project on it. You add and edit them in **Settings → Crew**:
**Bots**, **Workflows** and **Roles**.

## Bots

**Settings → Bots** lists each environment's bots in rail order; drag one to reorder them, and
pick one to edit it. Every environment starts with **Captain**, which owns projects that were
never given to another bot. A new Captain starts with **Full access**. The pencil on a bot in the
bot list, or beside its name at the top of the sidebar, opens its settings too.

**Add bot** asks for a name, a robot avatar you build from parts (or **Shuffle**) and a color;
**Create** makes the bot on your default model and opens its headquarters. In its settings a bot
also has instructions, tools and a default model. The model picker also sets its reasoning, speed and **Access**, with the same levels as the composer: **Supervised** asks before commands and file changes, up to **Full access**. Changes apply when you
**Save**. A bot's threads, like a role's, get every T3 Code tool a thread you start gets, such as
the browser, worktrees and pull requests; tick some under **T3 Code** only to limit it to those.
They are offered only the crew tools its ticked crew tools allow. **Open thread** opens its headquarters, and the **⋯** menu moves it up or down or deletes it.

A bot's **Projects** tab lists the projects it owns on every connected environment. Move one to
another bot, or bring one over; work that already started keeps running as the bot that started
it. A project on another environment goes to the bot with the same name there, which is created
there if that environment doesn't have it yet. Projects on an environment that runs T3 Code
without Bosun are listed but can't be given to a bot until Bosun is installed there. You can also change a
project's bot in **Settings → Project → Bot**. A bot can only be deleted once it owns no projects
(its home folder doesn't count, and stays behind), and Captain can't be deleted. Deleting a bot
also deletes the automations that run as it.

Each bot has one **headquarters** thread where it oversees every project it owns. Clicking a bot in
the bot list opens it the first time, clicking the bot you're on opens it again, and ⌘-clicking
(Ctrl-clicking) a bot always opens it. You can also open it from the bot at the top of the sidebar (or the thread list on
mobile), or with **Open …'s thread** in the command palette. A dot there shows when it's
working or needs you. From there the bot can list its projects, hand them work, and answer their
questions. It hands each request to the project's [Project manager](#project-managers), which
replies in the headquarters as the work moves. When you ask the bot to do it itself, it starts
the work in the project directly instead: small, clear work as a **task**, a fresh agent in its
own worktree that opens a pull request, or a [feature](./features.md), which a lead runs with its
crew. Either way the work is one of that project's threads, listed and on the board with its other
work, and the bot links it in its reply. Each crew member runs with its role's model and **Access**. The bot can also start
projects from a name or by cloning a Git URL. With **Manage bots and roles**, which Captain has
from the start, it can create and edit bots and roles when you ask, such as "add a Security
reviewer role"; they show up like ones you made. A feature's threads, its lead's and its crew's,
carry a tag with the feature's name.

The headquarters follows the bot's current tools, model and **Access**. Its instructions are the
ones it started with until it starts a new session. Type **/new** in its composer, or pick
**Start new session…** in the thread's menu (or the command palette, or a long press on the bot on
mobile), to do that now: you keep the whole conversation, while the bot starts again from its
current instructions and the last few messages and looks up ongoing work instead of remembering it.
A **New session** divider in the thread shows where it began. A long conversation is otherwise compacted by
its provider; set **Long conversations** to **Start a new session** on the bot to do this instead,
once the bot has been quiet for half an hour. Opening the thread also brings back a deleted or
archived headquarters.

Each bot has a **home folder** of its own on its environment, where its headquarters works and
keeps its notes: `~/.bosun/bots/<bot id>`, a plain folder rather than a Git repository. It's made
when you add the bot, or when the bot first opens its headquarters or gets a scheduled task. It
isn't a project, so it doesn't show in project lists, has no Project manager, and can't be
deleted while it holds the bot's headquarters; if the folder is removed, it's made again the next
time the bot needs it. The bot's
**Projects** tab shows its path, with **Copy** and **Open** (Open uses your editor on that
environment); on mobile, long press the bot and choose **Copy home folder**. Headquarters that
lived in **No project** before move into their bot's home when the server starts, without running
anything. Their next turn starts a new session there that has neither the earlier conversation nor
the bot's instructions, so pick **Start new session…** once after the move to brief the bot again.

### Project managers

Each project has a **Project manager**: one pinned thread in the project that takes the requests
its bot hands it. It checks the project's issues and creates one when none tracks the request,
then decides how the work runs: a task for a small, clear change, a feature for one reviewable
pull request, or several features for bigger work, run one after another when they would collide.
It answers a feature's questions when the brief or the issue settles them, asks the bot otherwise,
and replies in the headquarters when the work starts, when it needs an answer, and when it's done.
When a pull request of its work merges into `staging`, it hears about it and closes the issues the
pull request resolves, and the milestone once all of its issues are closed; GitHub closes issues
itself for pull requests into `main`.
It reads the project's checkout but doesn't change it, and merges a pull request only when the
request or its instructions say to.

The bot list shows each project manager under the bots; clicking one opens it and narrows the
thread list to its project. With one project picked, a card for its manager sits at the top of the
thread list with what it's doing: click it to open the manager, or its ⚙ for its settings. It
also opens with **Open project manager** in the project's right-click menu or the command palette,
or from the link in the bot's reply; the thread is made the first time. A bot's **Lineage** lists
the work it started itself, not the requests it handed to a Project manager. Like a headquarters, it can't be deleted, opening it brings it
back if it was archived, and **/new** or **Start new session…** starts it over.

Its settings are in **Settings → Project → Project manager**: its icon, instructions, model and
**Access**, tools and **Long conversations**. Each manager gets a robot look picked from its
project until you **Change** it; **Use automatic** goes back. The icon saves on its own and
doesn't count as customizing the manager. It needs no roles: until you save changes there
it uses built-in instructions on the model of the bot that owns the project, and **Reset to
defaults** goes back to them. New instructions reach the thread when it next starts a new session;
model, **Access** and tools apply right away. When you or its bot give the manager a standing rule
for the project, such as "every piece of work starts from an issue", it adds the rule to its own
instructions and says so in its thread; the manager then shows as customized here, and the rule
applies from its next session. Its bot's headquarters can do the same for the bot's projects. The switch at the top turns a project's manager off: its
bot then does the project's work itself, requests still open go back to the bot, and the manager's
thread is archived until you turn it on again.

### The bot list

The bot list sits at the left edge of the window: your bots, then your project managers, each with
its latest message and how long ago it came. **Needs you** marks one waiting on you, a blue dot one
that's working, and a plain dot before the time a finished run you haven't opened. Below them are
**Automations** and **Pull requests**, and at the bottom the environment filter, **Usage** and
**Settings**.

Clicking a bot narrows the thread list and the board to its projects and takes you back to where
you left it, such as its board or a thread. The first time, and when you click the bot you're
already on, it opens its headquarters; ⌘-click (Ctrl-click) always does. To narrow them without
leaving the page, press **Cmd+1–9** (**Ctrl+1–9** on Windows and Linux) on desktop, or use
**Switch to …** in the command palette; the List / Board choice is remembered per bot, and in the
list that opens the bot's first thread. With several bots, jumping to a thread moves to
**Ctrl+Cmd+1–9** (**Ctrl+Alt+1–9**).

Drag the list's right edge to make it wider or narrower; drag it far enough left and it becomes a
column of icons, each with one mark: an amber count of threads waiting on you, a red dot when a
run failed, a blue dot while it works, or a plain dot for a finished run you haven't opened.
The round arrow tab that shows on the list's right edge when you point at it does the same, as
does **Toggle bot list** in the command palette, which you can give a shortcut in
**Settings → Keybindings**. Double-click the
edge to go back to the default width. The width and collapse are remembered on each device.

**Automations** lists your scheduled tasks by bot, with each one's schedule and next run; pick one
to edit it and see its recent runs. A task can also run as a bot: see
[Scheduled tasks](project-settings.md#scheduled-tasks). A red mark on Automations means a run
failed and you haven't opened that task since. **Pull requests** opens your pull requests. Pick a
bot to go back to its threads. On a server without bots, open Automations from the bottom of the
sidebar, or **Open automations** in the command palette; on mobile, Automations and Library are
the last entries in the bot button's menu.

Bots with the same name on different environments share one avatar, and new projects go to the
bot you're looking at. The server icon filters the bot list and thread list to some environments;
pick **All environments** to show every one again. To move a project, right-click it in the
sidebar's project picker and choose **Move to bot**.

## Workflows and roles

A workflow, in **Settings → Workflows**, is how a kind of feature runs: a name, the role that
leads it, the crew roles the lead can hand work to, and instructions for the lead. **New
workflow** adds one. **Feature delivery** is the default and can be edited but not deleted. A role no workflow
uses says **Not in a workflow**.

Roles, in **Settings → Roles**, are who leads a feature and who its lead can hand work to. **New
role** adds one, and offers **Add the starter roles** for a Feature manager, Planner,
Designer, Builder, QA Tester and Reviewer when an environment doesn't have them yet. The
Builder builds on its own and uses subagents only for read-only work such as research; give any
role **Threads and subagents** to let it use them. Each role has instructions, crew tools and a
default model, whose picker also sets reasoning, speed and **Access**, from **Supervised** to
**Full access**; starter roles start on **Full access**, since the crew works unattended. Pick a role to
edit it. Roles aren't deleted: the **On** switch at the top turns one off to retire it, and back
on. Each project gets its own Feature manager the first time a feature needs one; editing a role
changes the crews of features started later, not existing ones. A project's manager isn't a role; it's set up in the project (see
[Project managers](#project-managers)).

Editing bots, workflows and roles is available on web and desktop.

## Feature threads

A feature shows in the sidebar as one row, titled by the feature, with the crew members its lead
has handed work to on its third line. Clicking the row opens the thread waiting on you if there is
one, otherwise the feature's lead (its Feature manager's thread). A thread of the feature that
waits on you also shows under the row. The **Crew** tab in the right panel lists the lead and each
crew member's thread with its state, plus the feature's branch and pull request; a member handed
work twice shows as **Planner · try 2**. Subagents a crew member starts stay inside its thread.

Requests a bot handed on through its older crew tools share one row titled by the request, with
the crew members it went through; its first role is its lead. On mobile, the count on the row
opens a menu of the crew.

The mobile app runs features, and edits roles in **Settings → Roles**. The bot button in the thread list header opens the bot's headquarters. With more than one bot it also
switches bots, and its menu shows how many threads wait on you under each one. The List / Board
button beside it flips to the bot's features, with the ones waiting on you first. Choose
**Feature** under **Start as** in the new task sheet to start a feature with your prompt as its
brief. **Library** in the bot button's menu opens **Settings → Roles**. **Settings → Project**
shows and changes the project's bot and its Project manager's settings, and opens the Project
manager's thread.

The project checkout and provider account belong to the connected environment shown in Settings.
If that environment is offline, reconnect it to see current crew status or send an action.
