/**
 * The text a feature's lead starts from. Evals read it from here, so what they test is what a
 * lead gets.
 */

export const PROJECT_MANAGER_INSTRUCTIONS =
  "You lead one project's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";

/** The built-in workflow's instructions, which people can edit. */
export const FEATURE_DELIVERY_INSTRUCTIONS =
  "Have the Planner plan it, then ask the person to approve the plan. Have the Designer design it if it needs one. Have the Builder build it, then the QA Tester check it and the Reviewer review the diff; send what they find back to the Builder until both pass. Then have the Builder commit, push and open the pull request. Skip what the work doesn't need.";

/** What a crew run's thread is first told: its role's instructions and its task. */
export const crewRunPrompt = (run: { readonly instructions: string; readonly taskText: string }) =>
  `${run.instructions}\n\nTask:\n${run.taskText}`;

/**
 * A feature lead's task: the workflow it follows and what differs per feature. A lead can be any
 * role, so the task says how to hand work to the crew.
 */
export const featureLeadTask = (
  feature: { readonly id: string; readonly title: string; readonly brief: string },
  workflow: { readonly name: string; readonly instructions: string },
  crew: ReadonlyArray<string>,
) =>
  [
    `Workflow: ${workflow.name}\n${workflow.instructions}`,
    `Feature: "${feature.title}" (${feature.id})`,
    crew.length > 0
      ? `Crew: ${crew.join(", ")}. Give one a task with delegate_task, setting crewMember to their name; their result comes back here.`
      : "Crew: none. Do the work yourself.",
    `Brief:\n${feature.brief.slice(0, 8_000)}`,
  ].join("\n\n");
