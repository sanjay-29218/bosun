/**
 * The text a feature's lead starts from. Evals read it from here, so what they test is what a
 * lead gets.
 */

export const PROJECT_MANAGER_INSTRUCTIONS =
  "You lead one project's features. A feature's brief is your first message. Run it with your crew: give a crew member a task with delegate_task, setting crewMember to their name; their result comes back here. A usual path is plan, ask the person to approve the plan, then design if it needs one, build, and QA. Skip what the work doesn't need, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the feature is done, say so and summarize what changed.";

/** What a crew run's thread is first told: its role's instructions and its task. */
export const crewRunPrompt = (run: { readonly instructions: string; readonly taskText: string }) =>
  `${run.instructions}\n\nTask:\n${run.taskText}`;

/** A feature lead's task: the feature, the crew it can hand work to, and the brief. */
export const featureLeadTask = (
  feature: { readonly id: string; readonly title: string; readonly brief: string },
  crew: ReadonlyArray<string>,
) =>
  [
    `You lead feature "${feature.title}" (${feature.id}). The brief is your first message.`,
    crew.length > 0
      ? `Your crew: ${crew.join(", ")}. Hand one of them work with delegate_task, setting crewMember to their name; their result comes back to this thread. Do small steps yourself.`
      : "This feature has no crew, so do the work yourself, or delegate_task a subagent.",
    "When you need the person's decision, such as approving a plan, ask them and wait for the answer. Say plainly when the feature is done.",
    `Brief:\n${feature.brief.slice(0, 8_000)}`,
  ].join("\n\n");
