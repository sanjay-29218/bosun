# Bots and roles

A **bot** (Captain, Social, Finance…) owns projects and runs their work. A **role** is a kind of
crew member, such as Planner or Builder, that a feature's lead can hand work to. Both belong to an
environment and are shared by every project on it. Bots and the Library each have a place on the
rail.

## Bots

**Bots** on the rail lists each environment's bots in rail order; drag one to reorder them. Every
environment starts with **Captain**, which owns projects that were never given to another bot.
A new Captain starts with **Full access**. The pencil beside the bot's name at the
top of the sidebar opens its page too.

Use **+ New** for another bot. A bot has a name, a robot avatar you build from parts (or
**Shuffle**), a color, instructions, tools and a default model. **Access** sets how freely it works, with the same levels as the composer: **Supervised** asks before commands and file changes, up to **Full access**. Changes apply when you
**Save**. A bot's threads, like a role's, get every T3 Code tool a thread you start gets, such as
the browser, worktrees and pull requests; tick some under **T3 Code** only to limit it to those.
They are offered only the crew tools its ticked crew tools allow. **Open thread** opens its headquarters, and the **⋯** menu moves it up or down or deletes it.

A bot's **Projects** tab lists the projects it owns. Move one to another bot, or bring one over;
work that already started keeps running as the bot that started it. You can also change a
project's bot in **Settings → Project → Bot**. A bot can only be deleted once it owns no projects,
and Captain can't be deleted. Deleting a bot also deletes the automations that run as it.

Each bot has one **headquarters** thread where it oversees every project it owns. Clicking a bot in
the rail opens it the first time, clicking the bot you're on opens it again, and ⌘-clicking
(Ctrl-clicking) a bot always opens it. You can also open it from the bot at the top of the sidebar (or the thread list on
mobile), or with **Open …'s thread** in the command palette. A dot there shows when it's
working or needs you. From there the bot can list its projects, hand them work, and answer their
questions. It hands a project small, clear work as a **task**: a fresh project manager that works
in its own worktree of that project and opens a pull request. Work that needs planning or several
steps, or that you ask to be a feature, it starts as a [feature](./features.md), which a lead runs
with its crew. Either way the work is one of that project's threads, listed and on the board with
its other work, and the bot links it in its reply. A task's result, and what a feature's lead says
each time it stops, come back to the headquarters. Each crew member runs with its role's model and **Access**. The bot can also start
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

### The bot rail

A rail of bot avatars sits at the left edge of the window, with **Usage** and **Settings** at its
bottom. Clicking a bot narrows the sidebar and the board to its projects and takes you back to
where you left it, such as its board or a thread. The first time, and when you click the bot
you're already on, it opens its headquarters; ⌘-click (Ctrl-click) always does. To narrow them
without leaving the page, press **Cmd+1–9** (**Ctrl+1–9** on Windows and Linux) on desktop, or use **Switch to …** in the command
palette; the List / Board choice is remembered per bot, and in the list that opens the bot's first
thread. **Show All bots** in the command palette shows every bot's threads again; it has no
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
**Library** lists your workflows and roles; pick one to edit it. The pull request icon opens **Pull requests**. Pick a bot to go back to its threads. On a server without bots, open Bots, Automations and Library
from the bottom of the sidebar, or **Open bots**, **Open automations** and **Open library** in the command palette; on mobile, they're the last entries in the bot button's
menu.

Bots with the same name on different environments share one avatar, and new projects go to the
bot you're looking at, or to Captain from All bots. **+** adds a bot, and the pencil on the bot at the top of the sidebar edits
it. The server icon
filters the rail and sidebar to some environments; pick **All environments** to show every one
again. To move a project, right-click it in the sidebar's project picker and choose **Move to
bot**.

## Workflows and roles

A **Library** workflow is how a kind of feature runs: a name, the role that leads it, the crew
roles the lead can hand work to, and instructions for the lead. **+ New** beside Workflows adds
one. **Feature delivery** is the default and can be edited but not deleted. A role no workflow
uses says **Not in a workflow**.

The **Library**'s Roles are who leads a feature and who its lead can hand work to. **+ New**
beside Roles adds one, and offers **Add the starter roles** for a Project manager, Planner,
Designer, Builder, QA Tester and Reviewer when an environment doesn't have them yet. The
Builder builds on its own and uses subagents only for read-only work such as research; give any
role **Threads and subagents** to let it use them. Each role has instructions, crew tools and a
default model. **Access** sets how freely its threads work, from **Supervised** to **Full
access**; starter roles start on **Full access**, since the crew works unattended. Pick a role to
edit it. Roles aren't deleted: the **On** switch at the top turns one off to retire it, and back
on. Each project gets its own project manager the first time a request or feature needs one;
editing a role changes the crews of features started later, not existing ones.

Editing bots, workflows and roles is available on web and desktop.

## Feature threads

A feature shows in the sidebar as one row, titled by the feature, with the crew members its lead
has handed work to on its third line. Clicking the row opens the thread waiting on you if there is
one, otherwise the feature's lead (its project manager's thread). A thread of the feature that
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
shows and changes the project's bot.

The project checkout and provider account belong to the connected environment shown in Settings.
If that environment is offline, reconnect it to see current crew status or send an action.
