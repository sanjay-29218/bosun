# Features

A feature is a brief that a crew of roles takes through a workflow. The board shows every feature
across your projects and everything waiting on you. Click the board button at the top right of a
thread, press `mod+alt+shift+b`, or choose **Switch to Board** in the command palette; the same
button returns to your threads. The toggle appears when a connected environment runs
workflows, and the app opens on whichever view you used last.

## Start a feature

On the board, **New → New feature** opens a new thread in a new worktree with a workflow already
picked in the composer's **Workflow** picker; your first message becomes the brief. **Start
feature** on a todo does the same with the todo already written in, and the feature links to it.
The first time the board opens, **Start a feature** adds the starter workflow, "Feature delivery",
first. These pick the default workflow of the bot that owns the project, or the first workflow
when it has none. A plain new thread picks no workflow until you choose one. To change the default,
open the workflow in the **Library** and choose **Make default for** the bot from its **⋯** menu,
or edit the bot. The Library opens from the bot rail or the bottom of the sidebar.

A feature started from the board gets a new worktree. From a thread, it works where the
composer's **Local** / **New worktree** picker says. In a new worktree,
the feature gets one branch and folder, made from the base branch when its first stage starts, and
every stage and helper works there, so one feature becomes one pull request. **Local** works in
the project's own checkout. A feature made from an existing thread works in that thread's
workspace. Work too big for one builder is best split into separate features.

## The board

The board has four columns. **Todo** holds each project's open issues and tickets that no feature
works on yet, and features you haven't started. **Working** holds running, queued and paused
features. **Needs you** holds features waiting on an approval, an answer, your call after a loop
limit, or a failed stage, oldest first. **Done** holds finished and stopped features.

Your other threads sit beside the features, in the column their sidebar status puts them: running
ones in Working, ones waiting on an approval or answer in Needs you, and the rest in Done. Click
one to open it; hover for Snooze and Settle. Todo stays for work not started yet. Milestone, label
and workflow filters show only features and todos.

Each card shows its project, status, linked issue (or, without one, the feature's own number,
such as F-3), and branch or pull request. Its buttons, such
as Start feature, Approve, Answer…, Retry stage and Stop feature, act without opening the thread.
Click a card to open the thread its sidebar row opens: the one waiting on you, else the feature's
lead. Right-click it for the rest of the stage's menu,
such as Take over, Send back to…, Skip stage and Pause. After you take over a stage, its card
reads Taken over until you choose Mark done…, which asks for the route and a summary for the
next stage, or hand it back with Retry stage.

Cards move when the workflow moves them. Dragging a card into Done stops the feature, and dragging
it out reopens it. Reopening a finished feature asks which stage the follow-up starts at; a
stopped one resumes where it stopped.

Hover any feature for **Snooze** and **Settle**, as on a thread, or drag it onto **Settled** under
Done. Both act on the feature's threads, so the sidebar files it the same way, and a feature
snoozed or settled in the sidebar moves on the board too. Snoozed features wait in **Snoozed**
under Done until they wake; **Wake** brings one back early and **Un-settle** undoes a settle.

Search (the magnifier in the board's header, or `/`) matches titles, stages, projects, issue
numbers and feature numbers, and `workflow:feature-delivery` limits the features to one workflow. **Filter** narrows
the board to a project, a milestone or issue labels; each filter in effect shows below the
header, where its × removes it. **Display** switches between the columns and a list.

## Issues and tickets

A feature can link one issue or ticket. Every thread of the feature shows its number, and the
thread's details panel and hover card show its title, milestone and sub-issue progress. A brief
that contains an issue link, or a `Ticket T-14` line, links it when the feature starts, and the
crew can link the issue it opens. To link, change or unlink one yourself, choose **Link issue…** in
a card's menu, in a thread's **Feature** menu, or in the thread's details panel, and paste an issue
link or a ticket number such as `T-14`. Issue links work for GitHub.

Todo lists the open issues of each project's GitHub repository and its tickets. A ticket is a todo
kept in Bosun, numbered `T-1`, `T-2` and so on per project, for work that shouldn't be a public
issue or a project without GitHub. Issues are read with the environment's GitHub sign-in
(`gh auth login` or a token in Settings) and refresh every two minutes while the board is open.

**New todo** (**New → New todo** in the header, `C` on the board, or the command palette) asks for a title and a
description with headings, lists and checklists. When the project has GitHub issues, choose
**Ticket** or **GitHub issue**; the choice is remembered. Click a todo to open it beside the board.
A ticket's title, description and status edit in place, and **Move to GitHub issue** files it on
GitHub, moves its features to the new issue and deletes the ticket. A GitHub issue shows its
description, status and comments as GitHub has them; close or reopen it there, and edit its text on
GitHub. **Start feature** opens a new thread whose brief names the todo. The crew can list, read,
create and close todos too.

## Needs you

Features waiting on you collect in the board's Needs you column. Threads waiting on a tool
approval or a question come up at the top of the sidebar's thread list, and `mod+shift+y` opens
the one that has waited longest.
On Feature delivery (auto), a feature's approvals and questions wait on its lead first, and come
to you only when the lead asks.

On the board, `C` adds a todo and `/` opens search.
