---
name: manage-agent-skills
description: Find, register, and install Agent Skills through the central agent-skills repository. Use when the user asks to add or install an existing or third-party Skill for the current project, the current coding Agent globally, or every supported Agent globally.
disable-model-invocation: true
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
2. Run `<skill-real-path>/scripts/agent-skills.sh list` and reuse an existing Skill/source when possible. Do not assume `agent-skills` is installed on `PATH`.
3. When the user provides a GitHub repository or tree URL, inspect that exact source and identify its repository URL, ref, Skill path, and frontmatter name.
4. When only a name is provided, search skills.sh and GitHub. Show the exact source URL, ref, Skill path, and `SKILL.md` metadata; wait for confirmation before pulling executable content.
5. Stop on ambiguous matches, conflicting names, or an unverifiable `SKILL.md`. Never select the first fuzzy match silently.

Use the confirmed tree/path URL as `--source-url`; use the cloneable repository root as `--repo`. Reconstruct an existing source link from its repository and Skill path when necessary.

## Choose stable identifiers

- Reuse the registry source ID for an existing repository.
- For a new repository, prefer its lowercase repository name. If occupied by another URL, use `owner-repo`; stop if that also conflicts.
- For project scope, derive normalized `owner-repo` from the current Git remote on GitHub or another Git host. For nested groups, use the final group and repository. Fall back to the lowercase directory name only when the remote cannot be parsed. If the ID is bound elsewhere, ask for a different logical ID.

## Install and publish

Run the shell launcher from the user’s working directory. It records that directory, changes to the central `agent-skills` repository, and selects an installed Node.js 20+ runtime there. Set `AGENT_SKILLS_NODE` to an explicit compatible executable when automatic discovery cannot find one:

```bash
<skill-real-path>/scripts/install-skill.sh \
  --skill <skill-name> \
  --source-url <confirmed-source-url> \
  --scope <project|agent-global|all-global> \
  --agent <current-agent> \
  [--repo <clone-url> --source-id <source-id> --path <skill-path> --ref <ref>] \
  [--project <logical-project-id>]
```

Choose source flags from registry state:

- Existing Skill: omit `--repo`, `--source-id`, `--path`, and `--ref`; the registry values are reused.
- New Skill in an existing source: pass `--source-id` and `--path`; omit `--repo` and `--ref`.
- New source: pass `--repo`, `--source-id`, and `--path`; pass `--ref` only when pinning a non-default ref.

Do not invoke `install-skill.mjs` directly from the business project. Omit `--agent` only for `all-global`. The script refuses a dirty central repository, updates it to `origin/main`, reloads the updated installer when necessary, then performs the installation dry run. It branches from that main revision, applies a selective sync, validates the manager, reads the commit identity from the central repository’s Git configuration with global fallback, pushes, and opens a Draft PR.

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
