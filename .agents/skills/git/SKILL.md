---
name: git
description: Git workflow for branches, commits, and PRs. Invoke before any git operation.
args:
  - name: action
    description: "The git action: commit, pr, branch, merge, or worktree"
    required: true
capabilities:
  required-tools:
    - RunCommandTool
    - ReadFileTool
    - AskUserQuestionTool
tags:
  - git
  - workflow
---

# Git Workflow Skill

Standard git workflow for the Bounda project. All commits and PRs are authored solely by the repository owner — never include agent attribution (no `Co-Authored-By`, no bot signatures).

---

## Branch Strategy

### Main Branch (`main`)

- Protected branch — all changes go through PRs.
- Do NOT push directly to main.
- Always use feature branches + PR workflow.

### Feature Branches

Create from `main` for each unit of work.

**Naming:** `<type>/<description>` in kebab-case.

| Prefix      | Purpose                        |
|-------------|--------------------------------|
| `feat/`     | New feature                    |
| `fix/`      | Bug fix                        |
| `refactor/` | Code refactoring               |
| `docs/`     | Documentation                  |
| `chore/`    | Tooling, config, dependencies  |
| `test/`     | Test improvements              |

---

## Actions

### `worktree create [name]`

1. Call `EnterWorktree` with an optional `name` parameter.
   - This creates a worktree under `.claude/worktrees/<name>/` with a new branch based on HEAD.
   - The session's working directory switches to the worktree automatically.
2. The worktree branch is **not** a feature branch yet — use `/git branch` afterwards to create the properly named feature branch from within the worktree.

**Note:** `EnterWorktree` cannot be called if the session is already inside a worktree.

### `worktree exit [keep|remove]`

1. Ensure all changes are committed and pushed.
2. Call `ExitWorktree` with `action: "keep"` or `action: "remove"`.
   - `keep` — leaves the worktree and branch on disk (use when work will continue later).
   - `remove` — deletes the worktree and branch (use after PR is merged or work is abandoned).
3. If `remove` fails because of uncommitted changes, confirm with the user before retrying with `discard_changes: true`.

### `commit`

1. Run `git status` and `git diff` (staged + unstaged) to understand all changes.
2. Run `git log --oneline -5` to match the repository's commit style.
3. Stage only the relevant files by name — never use `git add -A` or `git add .`.
4. Draft a commit message following the format below.
5. Commit. Do NOT include `Co-Authored-By` or any agent attribution.
6. Run `git status` after the commit to verify success.

**Commit Message Format:**

```
<type>(<scope>): <subject>

<optional body>
```

- **type**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- **scope**: package or area affected (e.g., `core`, `codegen`, `config`)
- **subject**: imperative mood, lowercase, no trailing period
- **body**: explain **why**, not **what** — the diff shows what changed

Always pass the message via HEREDOC:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

Optional body explaining why.
EOF
)"
```

**If a pre-commit hook fails:**
- Fix the issue, re-stage, and create a NEW commit.
- Never amend unless the user explicitly asks.

**Note:** Formatting is handled automatically — the `PostToolUse` hook runs `biome check --write` on every file edit, and lefthook runs `biome check --write` on staged files at pre-commit. Run `pnpm check` before committing; typecheck and tests are not run by the hook.

### `pr`

1. Ensure the branch is up to date with `main`:
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Use `--force-with-lease` (never `--force`) if you need to push after rebase.

2. Run `git log` and `git diff main...HEAD` to review all commits since divergence.

3. Push the branch:
   ```bash
   git push -u origin <branch-name>
   ```

4. Create the PR via `gh pr create`:

```bash
gh pr create --title "<type>(<scope>): <subject>" --body "$(cat <<'EOF'
## Summary

<1-3 bullet points>

## Changes

- Change 1
- Change 2

## Key Features

- Feature or benefit 1
- Feature or benefit 2
EOF
)"
```

- PR title follows the same format as commit messages.

5. Return the PR URL to the user.

### `pr draft`

Create a draft PR early so progress is tracked on GitHub from the start. Used by `/lead` after the first phase commit.

**Inputs:** plan title, plan objective, branch name, completed phase count, total phase count.

1. Push the branch (first push — sets up remote tracking):
   ```bash
   git push -u origin <branch-name>
   ```

2. Create draft PR:
   ```bash
   gh pr create --draft --title "<type>(<scope>): <subject>" --body "$(cat <<'EOF'
   ## Summary

   <plan title and objective>

   ## Progress

   Implementation in progress — <completed>/<total> phases completed.

   _This PR will be updated as phases are completed._
   EOF
   )"
   ```

3. Return the PR URL and PR number.

### `pr ready`

Update the PR body with the full phase log and move it out of draft. Used by `/lead` after all phases are complete.

**Inputs:** PR number, phase log (YAML), plan title, plan objective.

1. Ensure the branch is up to date:
   ```bash
   git fetch origin
   git rebase origin/main
   ```
   Push with `--force-with-lease` if needed.

2. Build and update the PR body from the phase log:
   ```bash
   gh pr edit <pr-number> --body "$(cat <<'EOF'
   ## Summary

   <plan objective — the "why" behind this work>

   ## Changes

   <one bullet per phase: "Phase N: <title> — <diff_summary>">

   ## Key Decisions

   <all decisions from all phases, with rationale>

   ## Quality

   - Review iterations: <total across all phases>
   - Post-PR fixes: <count from simplify + review passes>
   EOF
   )"
   ```

3. Move PR to ready:
   ```bash
   gh pr ready <pr-number>
   ```

4. Return the result:
   ```yaml
   pr_url: "<final PR URL>"
   pr_number: <number>
   ```

### `branch`

1. Fetch and update main:
   ```bash
   git fetch origin
   git checkout main
   git pull origin main
   ```

2. Create the feature branch:
   ```bash
   git checkout -b <type>/<description>
   ```

### `merge`

Use after a PR has been merged on GitHub. Syncs local state and cleans up.

1. Determine the target branch the PR was merged into (usually `main`):
   ```bash
   gh pr view <pr-number-or-url> --json baseRefName --jq '.baseRefName'
   ```
   If no PR reference is given, default to `main`.

2. Switch to the target branch and pull:
   ```bash
   git checkout <target-branch>
   git pull origin <target-branch>
   ```

3. Delete the merged branch locally:
   ```bash
   git branch -d <merged-branch>
   ```

4. If the remote branch still exists, delete it too:
   ```bash
   git push origin --delete <merged-branch>
   ```

---

## Common Scenarios

### Branch is behind main

```bash
git fetch origin
git rebase origin/main
git push origin <branch> --force-with-lease
```

### Merge conflict during rebase

```bash
git status                    # see conflicts
# resolve in editor
git add <resolved-files>
git rebase --continue
```

### Update PR after review

```bash
git add <files>
git commit -m "fix: address review feedback"
git push origin <branch>
```

---

## Rules

- All git actions follow the attribution rules in AGENTS.md (no `Co-Authored-By`, no bot signatures).
- Never push directly to `main` — always use feature branches.
- Never use `--force` — use `--force-with-lease`.
- Never use `-i` (interactive) flags — they require TTY input.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`).
- Never use `git add -A` or `git add .` — stage files by name.
- Do not commit files that may contain secrets (`.env`, credentials).
- Do not push unless the user explicitly asks.
