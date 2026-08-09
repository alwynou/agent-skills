---
name: manage-agent-skills
description: Find, register, and install Agent Skills through the central agent-skills repository. Use when the user asks to add or install an existing or third-party Skill for the current project, the current coding Agent globally, or every supported Agent globally.
---

# Manage Agent Skills

Use this repository as the only owner of Skill sources and symlinks. Never install directly with another package manager.

## Determine the intended scope

- Infer scope from the user’s complete intent; do not keyword-match fixed phrases or treat the examples below as trigger words.
- When the user means the current project, repository, or workspace, use project scope for the Agent executing this Skill and use the current working directory as the project root.
- When the user means the current Agent’s personal or global installation, use global scope for that Agent and do not create a project target.
- When the user means every Agent, every AI tool, or device-wide availability, use global scope for all supported Agents and do not create a project target.
- Ask one concise question before acting when more than one interpretation remains plausible or the requested scope is absent.

The installation CLI uses internal adapter IDs. Pass the ID corresponding to the Agent executing this Skill; this is not a phrase the user must provide:

| Executing Agent | `--agent` value |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Kimi Code | `kimi-code` |
| Pi | `pi-agent` |
| OpenCode | `opencode` |

## Resolve the source

1. Locate this Skill’s real path and treat three directories above `scripts/install-skill.mjs` as the central repository.
2. Run `agent-skills list` there and reuse an existing Skill/source when possible.
3. When the user provides a GitHub repository or tree URL, inspect that exact source and identify its repository URL, ref, Skill path, and frontmatter name.
4. When only a name is provided, search skills.sh and GitHub. Show the exact source URL, ref, Skill path, and `SKILL.md` metadata; wait for confirmation before pulling executable content.
5. Stop on ambiguous matches, conflicting names, or an unverifiable `SKILL.md`. Never select the first fuzzy match silently.

Use the confirmed tree/path URL as `--source-url`; use the cloneable repository root as `--repo`. Reconstruct an existing source link from its repository and Skill path when necessary.

## Choose stable identifiers

- Reuse the registry source ID for an existing repository.
- For a new repository, prefer its lowercase repository name. If occupied by another URL, use `owner-repo`; stop if that also conflicts.
- For project scope, prefer the current Git remote’s normalized `owner-repo`. Fall back to the lowercase directory name. If the ID is bound elsewhere, ask for a different logical ID.

## Install and publish

Run the shell launcher from the user’s working directory. The launcher records that directory, changes to the central `agent-skills` repository, and only then starts Node so repository-specific version managers can select the compatible runtime:

```bash
<skill-real-path>/scripts/install-skill.sh \
  --skill <skill-name> \
  --source-url <confirmed-source-url> \
  --scope <project|agent-global|all-global> \
  --agent <current-agent> \
  [--repo <clone-url> --source-id <source-id> --path <skill-path> --ref <ref>] \
  [--project <logical-project-id>]
```

Do not invoke `install-skill.mjs` directly from the business project. Omit new-source flags only when the Skill already exists in the registry. Omit `--agent` only for `all-global`. The launcher requires Node.js 20 or newer; the script performs a dry run, refuses a dirty central repository before tracked changes, branches from `origin/main`, applies a selective sync, validates the manager, reads the commit identity from the central repository’s Git configuration with global fallback, pushes, and opens a Draft PR.

The commit title must be exactly:

```text
feat(skills): 添加 <skill-name> skill (<source-url>)
```

If only local binding or links change, expect no branch, commit, or PR. Report the installed scope, created links, locked commit, branch, commit, and Draft PR URL when present.

## Safety

- Never run Git mutations against the user’s working project; all publish commands must use the central repository path.
- Never overwrite unknown paths, reuse a conflicting source ID, reset, stash, or clean either repository.
- Do not bypass failed validation or authentication.
- Treat third-party Skills as executable code and preserve the reviewed commit in the lock file.
