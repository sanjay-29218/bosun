# Features

A feature is a brief that a crew of roles takes through a workflow. The board shows every feature
across your projects and everything waiting on you. Click the board button at the top right of a
thread, press `mod+alt+shift+b`, or choose **Switch to Board** in the command palette; the same
button returns to your threads. The toggle appears when a connected environment runs
workflows, and the app opens on whichever view you used last.

## Start a feature

The first time the board opens, **Start a feature** adds the starter workflow, "Feature
delivery", to the environment's workflows and opens a new thread. **New → New feature** opens a
new thread in the scoped project. A new thread's **Workflow** picker starts on the default workflow of
the bot that owns the project; pick **No workflow** for a plain thread. Change workflows in the
**Library**, in the bot rail or at the bottom of the sidebar.

A feature works where the composer's **Local** / **New worktree** picker says. In a new worktree,
the feature gets one branch and folder, made from the base branch when its first stage starts, and
every stage and helper works there, so one feature becomes one pull request. **Local** works in
the project's own checkout. A feature made from an existing thread works in that thread's
workspace. Work too big for one builder is best split into separate features.

## The board

The board has four columns. **Todo** holds each project's open issues and tickets that no feature
works on yet, and features you haven't started. **Working** holds running, queued and paused
features. **Needs you** holds features waiting on an approval, an answer, your call after a loop
limit, or a failed stage, oldest first. **Done** holds finished and stopped features.

Each card shows its project, status, linked issue, and branch or pull request. Its buttons, such
as Start feature, Approve, Answer…, Retry stage and Stop feature, act without opening the thread.
Click a card to open its current stage thread. Right-click it for the rest of the stage's menu,
such as Take over, Send back to…, Skip stage and Pause. After you take over a stage, its card
reads Taken over until you choose Mark done…, which asks for the route and a summary for the
next stage, or hand it back with Retry stage.

Cards move when the workflow moves them. Dragging a card into Done stops the feature, and dragging
it out reopens it. Reopening a finished feature asks which stage the follow-up starts at; a
stopped one resumes where it stopped.

Hover a Done card and choose **Settle**, or drag it onto **Settled** under Done, to fold it away.
Settling a feature settles its threads, so it moves to the sidebar's Settled shelf too, and a
feature settled in the sidebar folds away on the board. **Un-settle** brings it back.

Search (the magnifier in the board's header, or `/`) matches titles, stages, projects and issue
numbers, and `workflow:feature-delivery` limits the features to one workflow. **Filter** narrows
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

On the board, `C` adds a todo and `/` opens search.
