---
name: manage-agent-skills
description: Install, unlink, or completely delete Agent Skills through the central agent-skills repository. Use when the user explicitly asks to manage an existing, local, or third-party Skill for a project, one coding Agent globally, or every supported Agent globally.
disable-model-invocation: true
---

# Manage Agent Skills

Use this repository as the only owner of Skill sources and symlinks. Never install directly with another package manager.

## Determine the intended scope

- Infer scope from the user’s complete intent; do not keyword-match fixed phrases or treat the examples below as trigger words.
- When the user means the current project, repository, or workspace, use project scope, use the current working directory as the project root, and make the Skill available to every supported Agent through the shared project directories.
- When the user means the current Agent’s personal or global installation, use global scope for that Agent and do not create a project target.
- When the user means every Agent, every AI tool, or device-wide availability, use global scope for all supported Agents and do not create a project target.
- Ask one concise question before acting when more than one interpretation remains plausible or the requested scope is absent.

Global installation for one Agent uses internal adapter IDs. Pass the ID corresponding to the Agent executing this Skill; project installation is shared and does not require an Agent ID:

| Executing Agent | `--agent` value |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Kimi Code | `kimi-code` |
| Pi | `pi-agent` |
| OpenCode | `opencode` |

## Determine the intended operation

- Treat “remove”, “uninstall”, or equivalent wording as unlinking only when the user wants to stop exposing a Skill at one or more scopes. This preserves the Skill source and uses `remove`.
- Treat “delete completely”, “delete the Skill itself”, or equivalent wording as deleting the registered Skill and its owned content. This uses `delete`.
- Treat an explicit request to delete a whole third-party source as deleting every registered Skill from that source plus its lock, submodule, and vendor checkout. This uses `delete --source` and never accepts `local`.
- Ask one concise question when unlinking and complete deletion are both plausible. Do not infer complete deletion from a vague removal request.
- Never delete `manage-agent-skills` through its own workflow.

## Resolve the source

1. Locate this Skill’s real path and treat three directories above `scripts/install-skill.mjs` as the central repository.
2. Run `<skill-real-path>/scripts/agent-skills.sh list` and reuse an existing Skill/source when possible. Do not assume `agent-skills` is installed on `PATH`.
3. When the user provides a GitHub repository or tree URL, inspect that exact source and identify its repository URL, ref, Skill path, and frontmatter name.
4. When only a name is provided, search skills.sh and GitHub. Show the exact source URL, ref, Skill path, and `SKILL.md` metadata; wait for confirmation before pulling executable content.
5. Stop on ambiguous matches, conflicting names, or an unverifiable `SKILL.md`. Never select the first fuzzy match silently.

Use the confirmed tree/path URL as `--source-url`; use the cloneable repository root as `--repo`. Reconstruct an existing source link from its repository and Skill path when necessary.

## Choose stable identifiers

- Reuse the registry source ID for an existing repository.
- For a new repository, prefer its lowercase repository name. If occupied by another URL, use `owner-repo`; stop if that also conflicts.
- For project scope, derive normalized `owner-repo` from the current Git remote on GitHub or another Git host. For nested groups, use the final group and repository. Fall back to the lowercase directory name only when the remote cannot be parsed. If the ID is bound elsewhere, ask for a different logical ID.

## Install

Run the shell launcher from the user’s working directory. It records that directory, changes to the central `agent-skills` repository, and selects an installed Node.js 20+ runtime there. Set `AGENT_SKILLS_NODE` to an explicit compatible executable when automatic discovery cannot find one:

```bash
<skill-real-path>/scripts/install-skill.sh \
  --skill <skill-name> \
  --source-url <confirmed-source-url> \
  --scope <project|agent-global|all-global> \
  [--agent <current-agent>] \
  [--repo <clone-url> --source-id <source-id> --path <skill-path> --ref <ref>] \
  [--project <logical-project-id>] \
  [--no-push]
```

Choose source flags from registry state:

- Existing Skill: omit `--repo`, `--source-id`, `--path`, and `--ref`; the registry values are reused.
- New Skill in an existing source: pass `--source-id` and `--path`; omit `--repo` and `--ref`.
- New source: pass `--repo`, `--source-id`, and `--path`; pass `--ref` only when pinning a non-default ref.

Do not invoke `install-skill.mjs` directly from the business project. Pass `--agent` only for `agent-global`; project scope creates `.agents/skills/<name>` plus `.claude/skills/<name>` compatibility links. The script refuses a dirty central repository, updates it to `origin/main`, reloads the updated installer when necessary, then performs the installation dry run.

The commit title must be exactly:

```text
feat(skills): 添加 <skill-name> skill (<source-url>)
```

If only local binding or links change, expect no commit. Report the installed scope, created links, locked commit, and commit hash.

## Remove or delete

Run the change launcher from the user’s working directory. It changes to the central repository before selecting Node.js and running the manager:

```bash
# Remove one project target
<skill-real-path>/scripts/change-skill.sh \
  --action remove --skill <skill-name> \
  --scope project --project <logical-project-id>

# Remove one Agent globally, every Agent globally, or every target
<skill-real-path>/scripts/change-skill.sh \
  --action remove --skill <skill-name> \
  --scope <agent-global|all-global|all> [--agent <current-agent>]

# Completely delete one Skill or a whole third-party source
<skill-real-path>/scripts/change-skill.sh --action delete --skill <skill-name>
<skill-real-path>/scripts/change-skill.sh --action delete-source --source <source-id>
```

Every form accepts `--no-push` to keep the commit local.

Removing the final target leaves the Skill disabled and available for a later reinstall. Deleting a local Skill removes its clean, tracked `skills/<name>` directory. Deleting the only Skill from a third-party source removes the source too; when other registered Skills share that source, the source, lock, and vendor remain. Whole-source deletion is explicit and atomic. Unknown, shared local, or out-of-tree content causes a safe refusal.

Modified or untracked content always refuses. Ignored content is weighed by location: inside a local Skill it may be the user’s own data and refuses, while inside a vendor it is build output of a re-clonable upstream checkout, so deletion proceeds and reports it as `ignoredPaths`. Relay those paths when they appear. An uninitialized vendor submodule holds nothing to lose and never counts as dirty.

The change launcher uses these commit titles:

```text
chore(skills): 移除 <skill-name> 的 <scope> 安装
chore(skills): 删除 <skill-name> skill
chore(skills): 删除 <source-id> source 及其 Skills
```

It skips the commit entirely for an idempotent no-op.

## How a change reaches the repository

The central repository holds the user’s own Skill configuration, so `main` is the only branch that ever represents it. Both launchers commit straight to `main`; they never create a branch or a pull request.

Each publishing run applies the registry, lock, and vendor edits first, validates them, commits them on `main`, and only then reconciles the symlinks. A failure before the commit therefore leaves the machine’s links untouched and restores the central repository to a clean `main`. Validation is scoped to what changed: registry-only edits just prove the registry still resolves, while edits under `src`, `bin`, `tests`, `skills/manage-agent-skills`, or the build configuration run the full check and build.

After committing, the launcher pushes `main` unless `--no-push` was passed. A rejected push is reported as a warning rather than a failure, because the commit and the links already agree locally; rerun the push after reconciling with `origin`.

## Safety

- Never run Git mutations against the user’s working project; all publish commands must use the central repository path.
- Never overwrite unknown paths, reuse a conflicting source ID, reset, stash, or clean either repository.
- Do not bypass failed validation or authentication.
- Treat third-party Skills as executable code and preserve the reviewed commit in the lock file.
