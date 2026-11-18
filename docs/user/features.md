# Features

A feature is a brief that a Feature manager leads to done with a crew of roles. The board shows
every feature across your projects and everything waiting on you. Click the board button at the
top right of a thread, press `mod+alt+shift+b`, or choose **Switch to Board** in the command
palette; the same button returns to your threads. The toggle appears when a connected environment
runs features, and the app opens on whichever view you used last.

## Start a feature

On the board, **New → New feature** opens a feature draft in a new worktree; your first message
becomes the brief. **Start feature** on a todo does the same with the todo already written in, and
the feature links to it. The composer's **Workflow** picker chooses how the feature runs, and
starts on **Feature delivery**. Sending the brief starts the feature and opens its lead's thread:
the workflow's lead, which has the workflow's instructions, the brief and the names of its crew as
its first message. The first
time the board opens, **Start a feature** adds the starter roles first.

Most features start from a bot's request: the bot hands it to the project's
[Project manager](./bots.md#project-managers), which starts a feature when the work needs one,
links the issue it tracks, and hears one line when the feature needs the person, finishes or
fails, not with each step. Notices that arrive while a thread is busy reach it as one message when
it is free. Ask a bot to start
the feature itself, and it does the same as **New feature** without the Project manager.

Attach images or files to the brief to send them to the lead with it.

The lead works in the feature's own worktree and branch, made from the base branch when the
feature starts, so one feature becomes one pull request. From a thread, the feature works where the
composer's **Local** / **New worktree** picker says; **Local** works in the project's own
checkout. Work too big for one builder is best split into separate features: start it on the
**Epic** workflow.

## Big work: Epic

An **Epic** feature's lead splits the work into child features and asks you to approve the split.
Each child is an ordinary feature with its own worktree, branch, crew and pull request. A child
that builds on another starts from that child's branch, so their pull requests stack. When a
child's lead finishes, it reports to the Epic's lead with its summary and pull request, and the
Epic's lead starts what comes next. Closing a child that hasn't reported does the same. Once every
child is in, the Epic's lead checks them together in its own worktree and lists the pull requests
in the order to merge them.

On the board, children are listed under their Epic's card, each with its own status. The Epic's
column follows its lead and its open children, so it shows Working while any child runs. Click a
child to open its lead; its menu closes or reopens it.

## The lead and its crew

A feature follows a workflow from **Settings → Workflows**: the role that leads it, the crew roles it hands work to, and instructions for the lead.
**Feature delivery** is led by the Feature manager with a Planner, Designer, Builder, QA Tester
and Reviewer; you can edit it but not delete it. Crew roles that are turned off are skipped. The
lead hands a crew member a task, such as a plan for the Planner, and
the member's thread shows under the lead in the thread's **Crew** tab, named by the member. Each
member runs with its role's instructions and model, in the feature's worktree, and its result
comes back to the lead. The lead does small steps itself and skips what the work doesn't need.

When a step needs your approval, such as a plan or a design, the crew member who did it asks you
in its own thread, next to the work, with its name on the question ("Designer is asking for your
approval"). Pick **Approve**, or type what to change, and the member carries on; the lead hears
only the outcome. Dismissing the question tells the member it wasn't approved. The feature's card,
its notification and a push all open the thread that is asking. The lead asks its own questions
in its thread and waits for your answer; to ask the lead for changes, reply there. When the work
is done, the lead reports it, and its card reads **Ready for review**; close the feature from the
board once you're happy with it.

A feature notifies you when its lead stops for you, such as when it finishes, and whenever a
thread asks you something. Crew members finishing their turns and the lead handing work on stay
quiet; they still show as finished or unread in the app.

A needs-you line links to the thread that asks, and a finish line carries the pull request. A
bot's headquarters hears only when a feature finishes or fails.

## The board

The board opens on **Work**, with features and tasks grouped into **Needs input**, **Working**,
**Ready for review**, and **Done**. Done features have merged pull requests; an open pull request
is Ready for review. A stopped, unfinished lead reads **Waiting**; a failed lead reads **Failed**.
Pending approvals and questions take priority, followed by running turns.

Switch to **Issues** for open GitHub issues and tickets, grouped by milestone and parent.
Start work there without leaving the board. An issue with work links to its row in Work;
the issue number on a work row links back. Features without an issue that haven't started yet
also appear in Issues.

Use `W` and `I` to switch tabs, and `/` to search. The board remembers the last tab per project;
both tabs share search and project, milestone, and label filters. Each tab remembers whether
you prefer columns or a list. Phones use the list, with row actions available beside each item.

Use a feature's menu to close or reopen it. Closing doesn't mark its pull request merged.
**Snooze** and **Settle** act on its threads, matching the sidebar. Dragging onto **Settled**
settles the feature; **Wake** and **Un-settle** bring it back.

## Issues and tickets

A feature can link one issue or ticket. Every thread of the feature shows its number, and the
thread's details panel and hover card show its title, milestone and sub-issue progress. A brief
that contains an issue link, or a `Ticket T-14` line, links it when the feature starts, and the
crew can link the issue it opens. To link, change or unlink one yourself, choose **Link issue…** in
a card's menu, in a thread's **Feature** menu, or in the thread's details panel, and paste an issue
link or a ticket number such as `T-14`. Issue links work for GitHub. You can also name an issue
of the project's repository as `#56`, or an issue of another tracker by its key or link, such as
Linear's `LIN-123`; Bosun keeps that key and link but can't read the issue's title or state.

A small task a bot or lead hands off can link an issue too, so every piece of work traces back to
one. Ask the agent to name the issue when it hands the task off, or to link one later. The task's
thread shows it in its details panel and sidebar row, its parent shows it in **Lineage**, and its
card on the board shows its number. The agent working the task is told the issue and puts
`Closes #56` or `Refs #56` in its pull request.

Todo lists the open issues of each project's GitHub repository and its tickets. A ticket is a todo
kept in Bosun, numbered `T-1`, `T-2` and so on per project, for work that shouldn't be a public
issue or a project without GitHub. Issues are read with the environment's GitHub sign-in
(`gh auth login` or a token in Settings) and refresh every two minutes while the board is open.

**New todo** (**New → New todo** in the header, `C` on the board, or the command palette) asks for a title and a
description with headings, lists and checklists. When the project has GitHub issues, choose
**Ticket** or **GitHub issue**; the choice is remembered. Click a todo to open it beside the board.
A ticket's title, description and status edit in place, and **Move to GitHub issue** files it on
GitHub, moves its features to the new issue and deletes the ticket. A GitHub issue shows its
description, status and comments as GitHub has them; close or reopen it there, and click its title
or description to edit it in place. An issue shows its milestone and the issue it is part of: pick
either chip to set, change or clear it, or use **+ Milestone** and **+ Parent** when it has none. A
parent lists its **Sub-issues** under its description, each with the feature working on it and that
feature's pull request; **Add** puts an existing issue under it or files a new sub-issue. New todo
can set a GitHub issue's milestone and parent too, and a parent's milestone carries to a sub-issue
that has none. Paste a screenshot into either description to add it. A
ticket's images stay on its environment. GitHub takes no images through its API, so an issue's are
committed to a `bosun-attachments` branch of its repository, which anyone who can see the repository
can open. **Start feature** opens a new thread whose brief names the todo. Any other thread can
link the issue or ticket it works on with **Link issue…** in its details panel or its menu's
**Issue** item; a feature's threads share the feature's. In a thread, its issue opens as an
**Issue** tab in the right panel (`I` in Open a surface), and a pull request's summary lists the
issues its description closes ("Fixes #12"); click one to open it there, or Cmd-click to open it on
GitHub. The crew can list, read,
create and close todos too, and set or clear an issue's milestone and parent.

A project's [Project manager](./bots.md#project-managers) keeps the backlog. It files an issue for
a request no todo tracks, and a feature it starts is linked to that issue from its first message.
For work that ships as several pull requests it opens a GitHub milestone with a parent issue, files
each part's issue into the milestone as a sub-issue of the parent, and adds a missed part under an
Epic later. Milestones and sub-issues need the same GitHub access as filing issues.

## Needs you

Features waiting on you collect in the board's Needs you column. Threads waiting on a tool
approval or a question come up at the top of the sidebar's thread list, and `mod+shift+y` opens
the one that has waited longest.

On the board, `C` adds a todo and `/` opens search.
