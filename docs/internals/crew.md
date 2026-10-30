# Crew in T3 Code

T3 Code already gives a person durable threads and a provider runtime. Crew mode adds stable identities and durable coordination between those threads. A top-level bot (Captain, or one a person adds) owns each project. It receives a person's request for that project, delegates the work to the project's manager, and reports the linked result. The owning environment keeps the crew state and runs its providers; web, desktop, and mobile are clients of that environment. "Bot" is reserved for the top-level bots that own projects; everything here is crew.

## The boundaries that matter

- A **role** is reusable, environment-wide configuration: name, instructions, provider instance and model, T3 runtime mode, and allowed crew tools. Project manager, Planner, Designer, Builder, QA Tester, and Reviewer are starting roles, not an exhaustive enum. Users can add any role. Roles marked for workflow stages can be picked by a workflow and join features that start without one.
- A **crew member** is an independently addressable instance of a role. It snapshots the role's revision, then has its own configuration and scope. A project's manager belongs to the project and is created the first time a request or feature needs it; stage members belong to a feature. Editing a role must not silently rewrite existing members or runs.
- A **run** starts one T3 thread for one task. The run snapshots its member's instructions and tool grants. A continuation uses that thread; a later task gets another run. The thread remains the source for provider activity, approvals, checkpoints, and diffs. A started turn is not a completed task.
- A **handoff** is a durable, correlated request between runs with a structured result or question. Reusing its request ID is idempotent. Cancellation and retry retain the original request history. The server checks the caller's thread and tool grant before acting.

Roles, members, runs, and handoffs have separate storage in [the migrations](../../apps/server/src/persistence/Migrations.ts). Earlier migration files retain older storage shapes so existing databases can upgrade; later migrations rename and transform them. Member IDs such as `bot-captain` and `bot-manager:<project>` and the `bot-run:` thread prefix predate the Roles rename and stay, because stored runs, handoffs and grants reference them. The current store and validation live in [CrewStore](../../apps/server/src/crew/CrewStore.ts) and [CrewService](../../apps/server/src/crew/CrewService.ts).

## Bots as actors

A bot is not a crew member, but it acts in crew runs: a request to a project and every workflow stage without a supervisor run as the project's bot. Its authority comes from ownership, not grant rows. A bot only gets new runs on projects it owns, and a bot's run may delegate to members of that run's project ([CrewStore.canDelegate](../../apps/server/src/crew/CrewStore.ts)). Checking the run's project instead of current ownership means moving a project to another bot never strands a request or feature that is already running; only new work goes to the new owner. Ownership is `project.botId`, recorded by project events, so it replays like the rest of the project.

A headquarters lives as long as its bot, so its provider conversation keeps growing. By default the provider compacts it. A person can instead start it over (`bots.startNewSession`), or set the bot's `longConversation` to `new-session` so the crew does it past [`FRESH_START_TOKENS`](../../apps/server/src/crew/headquartersFreshStart.ts) after a quiet spell. Either way `thread.conversation.restart` retires the provider conversation and a briefing with the bot's current instructions and last few messages opens the next one. The thread keeps its messages for the person, but the model loses them, so anything a bot must still know later belongs in records it reads through tools (projects, features, handoffs), not only in its chat.

## Hierarchy, permissions, and workflow

These answer different questions and should not be encoded as one `role` column:

1. **Hierarchy:** who owns or supervises whom. Siblings have equal standing. A Builder's request to change a plan or design goes to its feature lead; it does not automatically climb through Designer and Planner. The feature lead can route a new task. Review and QA remain independent of Builder.
2. **Action permissions:** what a member may ask, delegate, answer, approve, or write. The server enforces each action using the caller's authenticated run and explicit grants. Prompt instructions are guidance, not authorization. The current delegation path uses exact source/target grants and per-run tool grants; other action types need their own explicit policy before use.
3. **Workflow:** which step follows which, and under what condition. The configurable step graph and automatic progression are a separate Workflow feature. Role defaults can exist before that graph; creating members must not implicitly mark a feature planned, built, tested, or reviewed.

Workflows are one environment-wide library. A definition holds its roles (each a global role pinned to a revision), supervisor links, and step routes together so one canvas can edit the whole arrangement. A role slot made from the project manager role binds to the running project's manager instead of a new member, so one workflow works in every project. The supervisor link does not grant an action or determine the next step; a recorded outcome must match an explicit route. The starter workflow routes change requests to a project manager step for a decision before revisiting Design or Build. Re-entering a step creates a new execution, while retrying a failed execution creates another attempt.

The first coordination path is project bot → project manager → Builder. The [handoff service](../../apps/server/src/crew/CrewHandoffService.ts) persists requests, checks delegation grants, bounds depth and payloads, routes questions and structured outcomes, and recovers pending work. The [thread runtime](../../apps/server/src/crew/CrewThreadRuntime.ts) enters T3's existing orchestration engine; it does not launch provider CLIs directly. Deterministic thread and command IDs let a restart retry accepted work without creating another user turn.

## Scope and next boundaries

One environment owns a project's filesystem, provider credentials, and crew records. Remote and tunnel clients call the same authenticated RPCs as local clients. A bot spanning several environments needs its own durable home, delegated per-environment authority, revocation, and an explicit offline policy; a client tab cannot be that home.

Feature work needs a feature record and one writer lease for its checkout. Planner, Designer, Builder, QA Tester, and Reviewer may have separate threads and can work concurrently where their permissions and artifacts allow it. A member's provider runtime mode controls T3 approval behavior; it is not a grant to change another member's task, approve an artifact, push a branch, or publish to an external service. Those actions need server-side policy and attributable results. The current crew foundation provides a hierarchy editor and exact delegation grants, but feature worktree coordination remains separate work.

## What passes between workflow stages

Each stage attempt runs in a fresh crew thread, and the only thing it inherits is its [stage handoff record](../../apps/server/src/workflows/StageHandoff.ts). That record holds the brief, the outputs the step `receives` (declared files at their latest version and earlier stage threads' checkpoint diffs), the summary that routed work here, people's decision notes, the previous attempt's error, and the branch and commit. It is persisted before dispatch, and the prompt is rendered from the stored record, so the card a person sees is exactly what the member got and a restart re-delegates identical text. New context for a stage belongs in the record, not in a side channel.

A stage made from a person's existing thread (`attached` in [the fold](../../apps/server/src/workflows/WorkflowState.ts)) is the exception. It has no crew run and no handoff record: it starts taken over, and the workflow completes it when that thread's latest turn completes, citing the run ID and routing the last reply on through the stage's gate. Since there is no handoff receipt to wake the reconciler, `run.updated` for a non-crew thread looks up attached features through an index, so keep that lookup cheap.

A feature runs on the copy of its workflow taken when it was created. Publishing a new version only changes what later features copy. Moving a running feature would mean replaying its history against a different step graph and crew, so it is deliberately not supported.
