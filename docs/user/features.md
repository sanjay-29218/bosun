# Features

A feature is a brief that a crew of bots takes through a workflow. The **Features** page shows
every feature across your projects and everything waiting on you. Open it from the sidebar
footer, with `mod+shift+b`, or with **Open features** in the command palette. It appears when a
connected environment runs workflows.

## Start a feature

The first time the page opens, **Start a feature** adds the starter workflow, "Feature
delivery", to the project and opens a new thread. **New feature** opens a new thread in the
scoped project. Change workflows in **Settings → Project → Workflows**.

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

Use **List** for the same features grouped by phase. Search matches titles, stages and
projects, and `workflow:feature-delivery` limits it to one workflow.

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

On the page, `l` shows the list, `b` the board, `w` toggles Workflow and `n` toggles Needs you.
