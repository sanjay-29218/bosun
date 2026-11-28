# Bots and roles

A **bot** (Social, Finance…) owns projects and runs their work. A **role** is a kind of
crew member, such as Planner or Builder, that a feature's lead can hand work to. Both belong to an
environment and are shared by every project on it. You add and edit them in **Settings → Crew**:
**Bots**, **Workflows** and **Roles**.

## Bots

**Settings → Bots** lists each environment's bots in rail order; drag one to reorder them, and
pick one to edit it. A new install has no bots: **Create a bot** there, or in the **Bots** list,
makes the first one. Installs from before kept their **Captain**, which is an ordinary bot you can
rename, edit or delete. The pencil on a bot in the bot list, or beside its name at the top of the
sidebar, opens its settings too.

**Add bot** asks for a name, a robot avatar you build from parts (or **Shuffle**) and a color;
**Create** makes the bot on your default model and opens its headquarters. When you're connected to
several machines that run bots, it also asks which one the bot **Lives on**: its settings, chat,
memory, automations and home folder stay on that machine, and its settings say so under its name. In its settings a bot
also has instructions and a default model, whose picker also sets its reasoning and speed. Changes apply when you
**Save**. Every bot, role and project manager can use every tool an ordinary thread can, with
**Full access**: starting features and tasks, delegating, worktrees, pull requests, and managing
bots, roles and workflows. There is nothing to grant. **Open thread** opens its headquarters, and the **⋯** menu moves it up or down, copies or moves it to another machine (see below), or deletes it.

A bot's **Projects** tab lists the projects it owns on every connected environment. **Add project**
gives it another, and the **✕** on a row takes one off it, leaving that project with no bot; work
that already started keeps running as the bot that started it. Projects and bots don't need each
other: a project works with no bot, and a bot with no projects. **Add project** lists the projects
on the bot's own machine and on the machines linked to it (see below); other machines' projects
don't show. A project on a linked machine stays there, and the bot works on it from its own
machine, with no copy of the bot there; once added, the bot can hand it work straight away. That
project's **Settings → Project → Bot** shows the owner as "Atlas · lives on Mac Studio". A project
on a machine that isn't answering shows **Offline**; requests to it wait. Projects on a linked
machine that runs T3 Code without Bosun, or that's linked below **Full access**, are listed but
can't be added until you install Bosun there or link it again with Full access. You can also change
a project's bot in **Settings → Project → Bot**, or pick **No bot**: a project with no bot still has
its project manager, which runs on the project's default model (else the environment's). Picking
a bot shows only the projects it owns, so a project with no bot shows under no bot; **Projects**
always lists it. Its project manager, pinned in the rail or listed under **Bots**, opens from
anywhere. A bot can only be deleted once it owns no projects (its
home folder doesn't count, and stays behind on Delete): remove each first.
Deleting a bot also deletes the automations that run as it.

Every bot and project manager can work on every machine linked to its own (Linked environments in
**Settings → Labs**). That list, and each link's access level, is the only control: there is
nothing to tick per bot. Unlinking a machine there stops new work on it, while work already running
keeps going. A bot or manager still lives on one home machine.

When the bot hands work to a project on a machine that's asleep or offline, the request waits
instead of failing: its row in the headquarters says **Waiting for MacBook. It starts when MacBook
is back**, and it starts by itself once that machine answers, even after a restart. If that machine answers but can't start it yet, the row says what it answered instead. A machine with no roles of its own runs the work with the workflow this machine sends. To cancel it, open the thread details and press Stop on its row under **Lineage**; if it had already reached that machine, it's stopped there once that machine answers. Unlinking the machine while a request waits fails it.

#### Copy or move a bot to another machine

A bot lives on one machine, but you can copy it or move it to a machine linked to that one. Pick
**Copy to another machine…** or **Move to another machine…** in the bot's **⋯** menu, or **Move…**
next to **Lives on** under its name, then the machine. Before you confirm, the dialog shows what
will happen to the bot's projects and automations.

- **Copy** makes a separate bot there with the same name, look, instructions, model and home
  folder files. Its automations come along
  turned off, so they don't run on both machines; turn them on there when you're ready. The
  original stays as it is and keeps its projects. The two aren't kept in sync.
- **Move** does the same, then hands the bot's projects to the moved bot and removes it from the
  old machine completely: its settings, home folder, automations and headquarters thread. Its
  automations stop first and start again on the new machine, so they never run on both. The bot
  starts a fresh headquarters thread there and keeps its memory, which lives in its home folder.
  A project comes along when the new machine can reach the project's machine; a project on a
  machine the new one has no link to is left with no bot, and the dialog says which. To bring
  those along, link that machine from the new one first. If the move fails, the bot stays where
  it was, unchanged. If the new machine stops answering mid-move, the bot's automations stay paused
  here, since it may already run them, and can't be turned back on; move the bot to that machine
  again to finish, which works from any client, or pick **Cancel move** in the dialog to keep it
  here. If that machine can't be reached any more, cancelling leaves the automations off, since it
  may still run them; turn them on once you're sure it doesn't. Once the new machine has taken the
  bot, the move can only finish: there's no Cancel move. If that machine can't be reached any more,
  or no longer has the bot's copy, **Stop waiting** keeps the bot here with its automations off. You can move it back the same
  way once the new machine links back.

Both need the other machine on a link with **Full access**, running a Bosun version that can take
bots; otherwise the dialog says to link it again or update Bosun there. A bot that's working, in its
headquarters or another thread in its home, can't move until it finishes or you stop it. A home folder can carry up to 1,000 files and
8 MB. Webhook automations get a new URL on the new machine and leave their signing secret behind,
so they arrive turned off: point the sender at the new URL, set a signing secret there if the
sender signs its requests, then turn them on. Copying and moving
aren't available in the mobile app; a moved bot shows there under its new machine.

#### Projects owned by a copy of a bot on another machine

Before bots could own projects on other machines, giving a project there to a bot made a copy of
that bot on that machine. The copy is an ordinary bot there and keeps owning those projects, so the
bot on your machine doesn't reach them. To move one, open the bot on your machine, choose **Projects
→ Add project**, and pick the project, which reads "MacBook · Atlas on MacBook". Once the copy owns
nothing, you can delete it on that machine.

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
work, and the bot links it in its reply. Each crew member runs with its role's model. The bot can also start
projects from a name or by cloning a Git URL, and create and edit bots and roles when you ask, such as "add a Security
reviewer role"; they show up like ones you made. Any thread can start a feature itself, without
going through a bot or a project manager. A feature's threads, its lead's and its crew's,
carry a tag with the feature's name.

The headquarters starts on the bot's model. Changing the model in its composer sticks; changing the
bot's model in its settings moves the headquarters to it. Its instructions are the
ones it started with until it starts a new session. Type **/new** in its composer, or pick
**Start new session…** in the thread's menu (or the command palette, or a long press on the bot on
mobile), to do that now: you keep the whole conversation, while the bot starts again from its
current instructions and the last few messages and looks up ongoing work instead of remembering it.
A **New session** divider in the thread shows where it began. A long conversation is otherwise compacted by
its provider. Opening the thread also brings back a deleted or archived headquarters.

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
back if it was archived, and **/new** or **Start new session…** in its thread's menu (on mobile, in
the thread's header) starts it over. A long conversation is compacted by its provider.

Its settings are in **Settings → Project → Project manager**: its icon and instructions. Its model is the one in its thread's composer: it starts on the
project's default model, and a model you pick there stays for every later turn, request and
automation. Each manager gets a robot look picked from its
project until you **Change** it; **Use automatic** goes back. The icon saves on its own and
doesn't count as customizing the manager. It needs no roles: until you save changes there
it uses built-in instructions, and **Reset to defaults** goes back to them. New instructions reach
the thread when it next starts a new session. When you or its bot give the manager a standing rule
for the project, such as "every piece of work starts from an issue", it adds the rule to its own
instructions and says so in its thread; the manager then shows as customized here, and the rule
applies from its next session. Its bot's headquarters can do the same for the bot's projects. The switch at the top turns a project's manager off: its
bot then does the project's work itself, requests still open go back to the bot, and the manager's
thread is archived until you turn it on again.

#### A project on several machines

A project cloned on several linked machines (matched by its repository) has one manager, on the
machine it **Lives on**; its copies elsewhere have none of their own. The bot list, **Bots** and
the project card show that one manager with its machine's name, and opening a copy's manager opens
it. **Settings → Project → Project manager** shows where it **Lives on**. It starts as the machine
whose manager already has a thread, otherwise the machine of the project's bot. Picking another
machine moves the manager there: the old machine's manager thread is archived, not deleted, its
open requests go back to their senders, and its automations are paused.

On every machine linked to the one it lives on, the manager can check the copy's threads and open
features, send its threads messages and hear the answers, and start features and tasks. It picks
the machine for each feature, and the base branch it names is that machine's. When a feature or
crew member there stops to ask you something, the manager hears so and can tell you it's blocked;
you answer in that thread. A machine that isn't linked can't be reached, and a request for a
machine that's offline waits until it's back.

If both machines already had a manager, the one on the machine it lives on stays, the other's
thread is archived, and the one that stays is told which manager it replaced and where. This needs
**Linked environments** (**Settings → Labs**) and a link from the machine it lives on to the
others. The manager doesn't read another machine's uncommitted files; it asks that machine's
feature lead.

### The bot list

The bot list sits at the left edge of the window: your pinned bots, then your pinned project
managers, each with its latest message and how long ago it came. **Needs you** marks one waiting on
you, a blue dot one that's working, and a plain dot before the time a finished run you haven't
opened. They scroll above a group pinned to the bottom: **Bots**, **Automations**, **Pull
requests**, an **Update** entry while a desktop update is available, downloading, ready to restart
or failed, then the environment filter, **Usage** and **Settings**. To check for an update by hand,
use **Settings → About** or the app menu.

**Bots** lists every bot and every project manager, pinned or not. The pin beside one adds it to
the bot list or takes it off; pins are saved on the server, so every device shows the same list.
Bots you add start pinned, and a new project's manager starts unpinned. Clicking a row opens that
bot's or manager's thread without changing which bot you're on, the gear opens its settings, and
**Add bot** makes a new bot. A count on **Bots** shows threads waiting on you that only an unpinned
bot or manager shows. On mobile, the bot button's menu lists the pinned bots and managers, then
**Bots**, with the same pins.

**Projects**, at the top of the bot list, shows every project on every connected machine, with or
without a bot, each in a folder with its threads and features. A project on several machines is one
folder. Right-click a folder for its project manager and its settings, and use **Add project…** in
the project picker above the list to add one. With no bots, Projects is what the list shows. New
projects added from it have no bot. **Show all projects** in the command palette picks it too, and
on mobile it's the first entry in the bot button's menu.

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
**Toggle bot list** in the command palette does the same, and you can give it a shortcut in
**Settings → Keybindings**. Double-click the edge to go back to the default width. The width and collapse are remembered on each device.

**Automations** lists your scheduled tasks by bot, with each one's schedule and next run; pick one
to edit it and see its recent runs. A task can also run as a bot: see
[Scheduled tasks](project-settings.md#scheduled-tasks). A red mark on Automations means a run
failed and you haven't opened that task since. **Pull requests** opens your pull requests. Pick a
bot to go back to its threads. On a server without bots, open Automations from the bottom of the
sidebar, or **Open automations** in the command palette; on mobile, Automations and Library are
the last entries in the bot button's menu.

Each bot is its own entry, even when a bot on another machine has the same name. With several
machines, the **Bots** list and **Settings → Bots** name each bot's machine, and show the bots of a
machine that can't be reached as **Offline**, as they were when last seen, until it's back. New
projects go to the bot you're looking at (or have no bot when you aren't looking at one). The server icon filters the bot list and thread list to some environments;
pick **All environments** to show every one again. To move a project, right-click it in the
sidebar's project picker and choose **Move to bot**.

## Workflows and roles

A workflow, in **Settings → Workflows**, is how a kind of feature runs: a name, instructions for
the feature's lead, and the crew roles the lead can hand work to. A feature's own thread is its
lead, so there is no lead role to set up: edit the instructions to change how features are led.
**New workflow** adds one. **Feature delivery** is the default and can be edited but not deleted. A role no workflow
uses says **Not in a workflow**.

Roles, in **Settings → Roles**, are who a feature's lead can hand work to. **New role** adds one,
and offers **Add the starter roles** for a Planner, Designer, Builder, QA Tester and Reviewer when
an environment doesn't have them yet. The
Builder builds on its own and uses subagents only for read-only work such as research. Each role
has instructions and a default model, whose picker also sets reasoning and speed. Its crew get
every tool with **Full access**, since they work unattended. Pick a role to
edit it. Roles aren't deleted: the **On** switch at the top turns one off to retire it, and back
on. Editing a role changes the crews of features started later, not existing ones. A project's manager isn't a role; it's set up in the project (see
[Project managers](#project-managers)).

### On other machines

Workflows and roles stay on the machine where you make them. To use one on another machine, open
**Settings → Workflows** or **Roles** there and choose **Import from…**. Pick a machine this one
links to (see [Link another environment](remote-access.md#link-another-environment)), tick what to
bring, and import. A workflow brings the roles it names that this machine doesn't have yet.

An import is yours to edit. Its row says where it came from (**From Studio VPS**), and
**Changed here** once you edit it. When the original changes, it shows **Update available**: open
it and choose **Take update** to replace this one with the original, **Skip** to hide that update
until a newer one, or **Keep as my own** to stop following the original. Features already running
keep the crew and workflow text they started with.

Saving a workflow or role that other machines imported asks **Also update on**: ticked machines
take your change within about a minute, and the rest see Update available. A machine whose copy has
its own edits starts unticked, because taking the change replaces them. The editor's **Imported
on** list shows each machine that has one and how current it is.

Updates travel over the importing machine's link, so a machine sees updates only from machines it
links to. If you unlink one, imports from it keep working; they stop showing updates until you link
it again. Copies from before imports show **Link it to get updates** until you link their machine
from this one.

If an item would replace a workflow or role this machine already has, including its own Feature
delivery or starter roles, the import asks you to confirm it first. A machine never lists what this
machine gave it.

Mobile has the same import screen, update banner and Also update on sheet.

#### A role's fallback model

A role can name a **Fallback model** under **Runs with**. When the role's own model can't run on
the machine running the feature, for example because its provider is signed out or out of usage,
the role uses its fallback model. If that can't run either, it uses the fallback model in
**Settings → Threads**. The thread says which model it switched to. Leave the role's fallback unset
to use the Settings one. An imported role brings its fallback model with it.

## Feature threads

A feature shows in the sidebar as one row, titled by the feature, with the crew members its lead
has handed work to on its third line. Clicking the row opens the thread waiting on you if there is
one, otherwise the feature's lead. A thread of the feature that
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
