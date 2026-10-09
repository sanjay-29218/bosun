# Bots in T3 Code

T3 Code already gives a person durable threads and a provider runtime. Bots add stable identities and durable coordination between those threads. A Captain receives a person's request, delegates project work to a Manager, and reports the linked result. The owning environment keeps the bot state and runs its providers; web, desktop, and mobile are clients of that environment.

## The boundaries that matter

- A **template** is reusable configuration: name, instructions, provider instance and model, T3 runtime mode, and allowed bot tools. Captain, Manager, Planner, Designer, Builder, QA Tester, and Reviewer are starting templates, not an exhaustive role enum. Users can add any template. Project templates can be marked for creation when a feature is created.
- A **bot** is an independently addressable instance. It can snapshot a template revision, then have its own configuration and scope. Captain can be environment-wide; Manager belongs to a project; feature crew members belong to a feature. Editing a template must not silently rewrite existing bots or runs.
- A **run** starts one T3 thread for one task. The run snapshots its bot's instructions and tool grants. A continuation uses that thread; a later task gets another run. The thread remains the source for provider activity, approvals, checkpoints, and diffs. A started turn is not a completed bot task.
- A **handoff** is a durable, correlated request between runs with a structured result or question. Reusing its request ID is idempotent. Cancellation and retry retain the original request history. The server checks the caller's thread and tool grant before acting.

Templates, bots, runs, and handoffs have separate storage in [the migrations](../../apps/server/src/persistence/Migrations.ts). Earlier migration files retain the old storage shape so existing databases can upgrade; subsequent migrations rename and transform it. The current store and validation live in [BotStore](../../apps/server/src/bots/BotStore.ts) and [BotService](../../apps/server/src/bots/BotService.ts).

## Hierarchy, permissions, and workflow

These answer different questions and should not be encoded as one `role` column:

1. **Hierarchy:** who owns or supervises whom. Siblings have equal standing. A Builder's request to change a plan or design goes to its Feature Lead; it does not automatically climb through Designer and Planner. The Feature Lead can route a new task. Review and QA remain independent of Builder.
2. **Action permissions:** what a bot may ask, delegate, answer, approve, or write. The server enforces each action using the caller's authenticated run and explicit grants. Prompt instructions are guidance, not authorization. The current delegation path uses exact source/target grants and per-run tool grants; other action types need their own explicit policy before use.
3. **Workflow:** which step follows which, and under what condition. The configurable step graph and automatic progression are a separate Workflow feature. Template defaults can exist before that graph; creating bots must not implicitly mark a feature planned, built, tested, or reviewed.

A workflow definition can hold bot template selections, supervisor links, and step routes together so one canvas can edit the whole arrangement. The supervisor link does not grant an action or determine the next step; a recorded outcome must match an explicit route. The starter workflow routes change requests to a Manager step for a decision before revisiting Design or Build. Re-entering a step creates a new execution, while retrying a failed execution creates another attempt.

The first coordination path is Captain → project Manager → Builder. The [handoff service](../../apps/server/src/bots/BotHandoffService.ts) persists requests, checks delegation grants, bounds depth and payloads, routes questions and structured outcomes, and recovers pending work. The [thread runtime](../../apps/server/src/bots/BotThreadRuntime.ts) enters T3's existing orchestration engine; it does not launch provider CLIs directly. Deterministic thread and command IDs let a restart retry accepted work without creating another user turn.

## Scope and next boundaries

One environment owns a project's filesystem, provider credentials, and bot records. Remote and tunnel clients call the same authenticated RPCs as local clients. A Captain spanning several environments needs its own durable home, delegated per-environment authority, revocation, and an explicit offline policy; a client tab cannot be that home.

Feature work needs a feature record and one writer lease for its checkout. Planner, Designer, Builder, QA Tester, and Reviewer may have separate threads and can work concurrently where their permissions and artifacts allow it. A bot's provider runtime mode controls T3 approval behavior; it is not a grant to change another bot's task, approve an artifact, push a branch, or publish to an external service. Those actions need server-side policy and attributable results. The current bot foundation provides a hierarchy editor and exact delegation grants, but feature worktree coordination remains separate work.

## What passes between workflow stages

Each stage attempt runs in a fresh bot thread, and the only thing it inherits is its [stage handoff record](../../apps/server/src/workflows/StageHandoff.ts). That record holds the brief, the outputs the step `receives` (declared files at their latest version and earlier stage threads' checkpoint diffs), the summary that routed work here, people's decision notes, the previous attempt's error, and the branch and commit. It is persisted before dispatch, and the prompt is rendered from the stored record, so the card a person sees is exactly what the bot got and a restart re-delegates identical text. New context for a stage belongs in the record, not in a side channel.

A feature runs on the copy of its workflow taken when it was created. Publishing a new version only changes what later features copy. Moving a running feature would mean replaying its history against a different step graph and crew, so it is deliberately not supported.
