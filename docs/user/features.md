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
the bot that owns the project; pick **No workflow** for a plain thread. Change workflows in
**Settings → Workflows**.

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

Search matches titles, stages, projects and linked issues, and `workflow:feature-delivery` limits
the board to one workflow. **Display** switches between the columns and a list grouped by phase.

## Issues

A feature can link one issue. Every thread of the feature shows its number, and the thread's
details panel and hover card show its title, milestone and sub-issue progress. A brief that
contains an issue link links it when the feature starts, and the crew can link the issue it opens.
To link, change or unlink one yourself, choose **Link issue…** in a card's menu, in a thread's
**Feature** menu, or in the thread's details panel. Issue links work for GitHub.

The **Issues** view at the top of the board lists the open issues of each project's GitHub
repository, grouped by milestone with sub-issues under their parent. Each row's status says where
it stands with the crew: Todo, In crew, In review once its feature reaches verify or ship, or Done
once the issue is closed. **Start feature** on an issue opens a new thread whose brief links it,
and a row with a feature opens the feature. **Display** changes the grouping, switches to status
columns, and shows recently closed issues. **Milestones** shows each open milestone's progress;
open one to see its issues. Issues are read with the environment's GitHub sign-in (`gh auth login`
or a token in Settings) and refresh every two minutes while the page is open. The crew can list
them too.

## The Workflow toggle

**Workflow** turns the columns into one workflow's stages, with each stage's role, its gate and
how many features wait there, and loops back to earlier stages. Pick the workflow next to the
toggle. Click a gate to show only the features waiting at it. Features on other workflows are
hidden; **Show phases** turns the toggle off. The toggle and the workflow are remembered per
project.

## Needs you

**Needs you** lists approvals, problems and questions, oldest first. Approve, Retry and Answer
work from the row; anything else opens the stage thread. Threads waiting on a tool approval or a
question are included.

The same threads appear in the **Needs you** shelf at the top of the sidebar, and
`mod+shift+y` opens the one that has waited longest.

On the board, `w` toggles Workflow and `n` toggles Needs you.
