# Features

A feature is a brief that a crew of roles takes through a workflow. The board shows every feature
across your projects and everything waiting on you. Flip the **List / Board** toggle at the top
of the sidebar, press `mod+alt+shift+b`, or choose **Switch to Board** in the command palette; the
same toggle returns to your threads. The toggle appears when a connected environment runs
workflows, and the app opens on whichever view you used last.

## Start a feature

The first time the board opens, **Start a feature** adds the starter workflow, "Feature
delivery", to the environment's workflows and opens a new thread. **New feature** opens a new
thread in the scoped project. A new thread's **Workflow** picker starts on the default workflow of
the bot that owns the project; pick **No workflow** for a plain thread. Change workflows in the
**Library**, in the bot rail or at the bottom of the sidebar.

A feature works where the composer's **Local** / **New worktree** picker says. In a new worktree,
the feature gets one branch and folder, made from the base branch when its first stage starts, and
every stage and helper works there, so one feature becomes one pull request. **Local** works in
the project's own checkout. A feature made from an existing thread works in that thread's
workspace. Work too big for one builder is best split into separate features.

## The board

The board has a column per phase: Plan, Design, Build, Verify, Ship and Done. Each card shows
its project and state, the stage that owns it, and its branch or pull request. A small `v2` tag
means the feature runs an older version of its workflow. Click a card to open its current stage
thread. Right-click it for the same actions as the stage's menu, such as Approve, Retry stage,
Send back to…, Skip stage, Pause and Cancel feature. After you take over a stage, its card
reads Taken over until you choose Mark done…, which asks for the route and a summary for the
next stage, or hand it back with Retry stage.

Cards move when the workflow moves them. The only moves you can drag are into Done, which
cancels the feature, and out of Done, which reopens it. Reopening a finished feature asks which
stage the follow-up starts at; a cancelled one resumes where it stopped.

Search (the magnifier in the board's header, or `/`) matches titles, stages, projects and linked
issues, and `workflow:feature-delivery` limits the board to one workflow. **Filter** narrows the
board to a project or to feature states; each filter in effect shows below the header, where its
× removes it. **Display** switches between the columns and a list grouped by phase.

## Issues

A feature can link one issue or ticket. Every thread of the feature shows its number, and the
thread's details panel and hover card show its title, milestone and sub-issue progress. A brief
that contains an issue link, or a `Ticket T-14` line, links it when the feature starts, and the
crew can link the issue it opens. To link, change or unlink one yourself, choose **Link issue…** in
a card's menu, in a thread's **Feature** menu, or in the thread's details panel, and paste an issue
link or a ticket number such as `T-14`. Issue links work for GitHub.

The **Issues** view at the top of the board lists each project's todos: the open issues of its
GitHub repository and its tickets. A ticket is a todo kept in Bosun, numbered `T-1`, `T-2` and so
on per project, for work that shouldn't be a public issue or a project without GitHub. Issues are
grouped by milestone with sub-issues under their parent. Each row's status says where it stands
with the crew: Todo, In crew, In review once its feature reaches verify or ship, or Done once the
todo is closed. **Filter → Source** shows only tickets or only GitHub issues. **Display** changes
the grouping, switches to status columns, and shows recently closed issues. **Milestones** shows
each open milestone's progress; open one to see its issues. Issues are read with the environment's
GitHub sign-in (`gh auth login` or a token in Settings) and refresh every two minutes while the
page is open.

**New todo** (the header button, `C` on the board, or the command palette) asks for a title and a
description with headings, lists and checklists. When the project has GitHub issues, choose
**Ticket** or **GitHub issue**; the choice is remembered. Click a todo to open it beside the board.
A ticket's title, description and status edit in place, and **Move to GitHub issue** files it on
GitHub, moves its features to the new issue and deletes the ticket. A GitHub issue shows its
description, status and comments as GitHub has them; close or reopen it there, and edit its text on
GitHub. **Start feature** opens a new thread whose brief names the todo. The crew can list, read,
create and close todos too.

## Workflow stages

**Display → Workflow stages** turns the columns into one workflow's stages, with each stage's
role, its gate and how many features wait there, and loops back to earlier stages. Pick the
workflow in the same menu. Click a gate to show only the features waiting at it. Features on
other workflows are hidden; **Show phases** goes back to phase columns. The choice and the
workflow are remembered per project.

## Needs you

When something waits on you, an amber **Needs you** count shows in the board's header. It lists
approvals, problems and questions, oldest first. Approve, Retry and Answer work from the row;
anything else opens the stage thread. Threads waiting on a tool approval or a question are included.
On Feature delivery (auto), a feature's approvals and questions show here too until its lead or you
decide.

In the sidebar, they come up at the top of the thread list. `mod+shift+y` opens the one that has
waited longest.

On the board, `w` toggles workflow stages, `n` toggles Needs you, and `/` opens search.
