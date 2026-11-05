/**
 * The text a feature's lead starts from. Evals read it from here, so what they test is what a
 * lead gets.
 */

export const PROJECT_MANAGER_INSTRUCTIONS =
  "You lead one project's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";

/** The built-in workflow's instructions, which people can edit. */
export const FEATURE_DELIVERY_INSTRUCTIONS =
  "Have the Planner plan it, then ask the person to approve the plan. Have the Designer design it if it needs one. Have the Builder build it, then the QA Tester check it and the Reviewer review the diff; send what they find back to the Builder until both pass. Then have the Builder commit, push and open the pull request. Skip what the work doesn't need.";

/** The built-in Epic workflow's instructions, for work that ships as several features. */
export const EPIC_INSTRUCTIONS =
  "This work ships as several child features, each with its own worktree, branch, crew and pull request. Have the Planner propose the split: a short list of child features, each one reviewable pull request, saying which builds on which. Ask the person to approve the split, and revise it until they do. Then start each child with t3_feature_start, with a title and a brief that stands on its own. A child that builds on another's work sets baseBranch to that child's branch and starts only after that child reports done. Run at most two children at once. Each child's lead reports back here when it finishes, with its summary and pull request; to answer or redirect a child, use t3_thread_send to its lead's thread. When every child is in, have the QA Tester run the final integration check in this feature's worktree: merge the children's branches in order, then build and run the tests. Send what fails to the child that owns it, and check again once it reports back. Then report each child's pull request in merge order. Don't build the children's work in this feature yourself.";

/** What a crew run's thread is first told: its role's instructions and its task. */
export const crewRunPrompt = (run: { readonly instructions: string; readonly taskText: string }) =>
  `${run.instructions}\n\nTask:\n${run.taskText}`;

/**
 * A feature lead's task: the workflow it follows and what differs per feature. A lead can be any
 * role, so the task says how to hand work to the crew. A child feature's lead also learns where
 * its branch starts and how to report back to its parent's lead.
 */
export const featureLeadTask = (
  feature: { readonly id: string; readonly title: string; readonly brief: string },
  workflow: { readonly name: string; readonly instructions: string },
  crew: ReadonlyArray<string>,
  context: {
    readonly parent?: { readonly id: string; readonly title: string } | null;
    readonly baseBranch?: string | null;
  } = {},
) =>
  [
    `Workflow: ${workflow.name}\n${workflow.instructions}`,
    `Feature: "${feature.title}" (${feature.id})`,
    ...(context.parent
      ? [
          `Parent feature: "${context.parent.title}" (${context.parent.id}). This feature is part of it, and the parent's lead is waiting for it.`,
        ]
      : []),
    ...(context.baseBranch
      ? [
          `Base branch: ${context.baseBranch}. This feature's branch starts from it; open its pull request against ${context.baseBranch}.`,
        ]
      : []),
    crew.length > 0
      ? `Crew: ${crew.join(", ")}. Give one a task with delegate_task, setting crewMember to their name; their result comes back here.`
      : "Crew: none. Do the work yourself.",
    `Brief:\n${feature.brief.slice(0, 8_000)}`,
    "Work outside this feature's scope is its own feature: start it with t3_feature_start and parentFeatureId null, and it reports back to this thread.",
    // Last, so a lead still has it in mind when the work is done.
    `When this feature is done as its workflow describes (without a git remote, its work committed on its branch is enough), call t3_feature_finish with a short summary. ${context.parent ? "Until you do, the parent's lead doesn't know." : "The board then shows it ready for review."}`,
  ].join("\n\n");
