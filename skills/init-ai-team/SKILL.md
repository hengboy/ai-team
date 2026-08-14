---
name: init-ai-team
description: Initialize AI Team in a target Git repository and verify the generated project context. Use when a user asks to set up, bootstrap, initialize, or reinitialize ai-team for a local project, including requests to run ai-team init, create the .ai-team project files, or validate the resulting MEMORY.md and feature navigation context.
---

# Initialize AI Team

Initialize the user-selected Git project with the installed `ai-team` CLI, preserve its confirmation boundary, and verify the resulting project context.

## Workflow

1. Obtain the target project path from the user. If it is missing or ambiguous, ask for it before running any command. Do not silently use the current repository.
2. Verify the prerequisites without changing the target:

   ```sh
   command -v ai-team
   git -C <project> rev-parse --show-toplevel
   ```

   Use the canonical Git root returned by the second command for every subsequent command. Stop and report the diagnostic if either command fails.
3. Run the initial setup without confirmation flags:

   ```sh
   ai-team init <canonical-project-root>
   ```

4. Inspect the command's JSON result.
   - If initialization succeeds, continue to validation.
   - If it fails because existing `.gitignore`, project context, or instruction files have uncommitted changes, show the reported dirty paths and ask the user whether to overwrite those exact files.
   - Do not add `--yes`, retry, or infer consent before the user explicitly confirms.
   - For any other failure, stop and report the command error and details.
5. After explicit confirmation for the reported dirty paths, retry exactly once:

   ```sh
   ai-team init <canonical-project-root> --yes
   ```

   Do not reuse that confirmation for a different path or a later run. Stop if the retry fails.
6. Validate the initialized context:

   ```sh
   ai-team context validate --project <canonical-project-root>
   ```

7. Report success only when the JSON result contains both:
   - `data.valid` equal to `true`
   - `data.maintenance.status` equal to `current`

   Otherwise, report the relevant `memory.issues`, `navigation.issues`, `navigation.invalid_paths`, instruction status, and `maintenance.paths`. Do not claim initialization is complete while context maintenance is pending.

## Boundaries

- Use the public `ai-team` commands above; do not recreate or patch their behavior.
- Do not inspect credentials, `.env*`, `.ai-team/runtime`, or files unrelated to the reported validation issues.
- Do not commit, merge, push, or otherwise mutate Git history unless the user separately requests that work.
- Do not run `ai-team context update` automatically. Validation findings may require File Explorer evidence and a separate context-maintenance task.
