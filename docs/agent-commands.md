# Agent Command Lifecycle

The generated `planning` and `coding` agents use this sequence:

1. Start a run and receive its first File Explorer dispatch.
2. Claim the dispatch, fetch its frozen prompt and schema, then submit a strict result.
3. Create additional role dispatches or a single pending user decision as required.
4. Planning writes an immutable revision and advances only valid state edges.
5. Coding asks Git Operator to prepare owned worktrees and commit only allowed paths.
6. Test completes independent verification before the review barrier.
7. Code Reviewer submits the required frozen Spec/Standards results exactly once.
8. Coding resolves every P0/P1 with change and verification evidence.
9. Git Operator performs the final no-fast-forward target merge and safe cleanup.

The CLI automatically advances persisted stages after successful dispatches.
Planning validates Task dependency graphs before worktree creation. On merge
conflict, the assigned developer resolves only allowed paths, Git Operator
continues the merge as a new commit, and Test runs the complete final gate
without opening a second review barrier.

Commands that create or mutate state are internal Agent commands even though
they are visible in CLI help. Platform renderers include only commands allowed
by the role manifest. Ordinary leaf agents cannot create dispatches or invoke
Git mutation.

Repository discovery is exclusive to File Explorer. Other agents use packet
paths and request support when they discover an unknown dependency. Researcher
receives project context from File Explorer and writes cited conclusions as
`fact`, `inference`, or `recommendation`; it does not search the target repo.

File Explorer also returns `payload.project_context`, including the project
shape, four managed MEMORY entry groups, module boundaries, navigation entries,
and maintenance status. Developers update the target project's `MEMORY.md` and
`.ai-work-flow/index/feature-navigation.md` with `context update`; Test and
review roles validate them before completion.
