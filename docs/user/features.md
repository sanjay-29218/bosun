# Features

A feature is a brief that a project's manager leads to done with a crew of roles. The board shows
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

Ask a full-access bot to start a feature in a project, and it does the same.

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

A feature follows a workflow from the **Library** (from the bot rail or the bottom of the
sidebar): the role that leads it, the crew roles it hands work to, and instructions for the lead.
**Feature delivery** is led by the Project manager with a Planner, Designer, Builder, QA Tester
and Reviewer; you can edit it but not delete it. Crew roles that are turned off are skipped. The
lead hands a crew member a task, such as a plan for the Planner, and
the member's thread shows under the lead in the thread's **Crew** tab, named by the member. Each
member runs with its role's instructions and model, in the feature's worktree, and its result
comes back to the lead. The lead does small steps itself and skips what the work doesn't need.

The lead asks you in its thread when it needs your decision, such as approving a plan, and waits
for your answer. To ask for changes, reply in the lead's thread. When the work is done, the lead
reports it, and its card reads **Ready for review**; close the feature from the board once you're
happy with it.

## The board

The board has four columns. **Todo** holds each project's open issues and tickets that no feature
works on yet, and features you haven't started. **Working** holds features whose lead or a crew
member is running. **Needs you** holds features waiting on you, oldest first: a thread asks for an
approval or an answer, or the lead has stopped and it's your turn. **Done** holds closed features.

Your other threads sit beside the features, in the column their sidebar status puts them: running
ones in Working, ones waiting on an approval or answer in Needs you, and the rest in Done. Click
one to open it; hover for Snooze and Settle. Todo stays for work not started yet. Milestone and
label filters show only features and todos.

Each card shows its project, status, the crew member the status is about, its linked issue (or,
without one, the feature's own number, such as F-3), and its branch or pull request. Click a card
to open the lead's thread. **Start feature** starts one in Todo, and **Close feature** and
**Reopen feature** are in its menu. Dragging a card into Done closes the feature, and dragging it
out reopens it. Closing leaves its threads as they are.

Hover any feature for **Snooze** and **Settle**, as on a thread, or drag it onto **Settled** under
Done. Both act on the feature's threads, so the sidebar files it the same way, and a feature
snoozed or settled in the sidebar moves on the board too. Snoozed features wait in **Snoozed**
under Done until they wake; **Wake** brings one back early and **Un-settle** undoes a settle.

Search (the magnifier in the board's header, or `/`) matches titles, projects, issue numbers and
feature numbers. **Filter** narrows the board to a project, a milestone or issue labels; each
filter in effect shows below the header, where its × removes it. **Display** switches between the
columns and a list.

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

On the board, `C` adds a todo and `/` opens search.
