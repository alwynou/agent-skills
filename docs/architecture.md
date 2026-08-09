# Architecture decision: Registry → Lock → Sync

Status: accepted for v0.1

## Context

Agent Skills already have a portable unit: a directory containing `SKILL.md` plus optional scripts, references, and assets. This project should manage those units, not invent a competing skill format.

Codex discovers user skills under `~/.agents/skills` and repository skills under `.agents/skills`; its official documentation explicitly supports symlinked skill directories. Claude Code discovers personal skills under `~/.claude/skills` and project skills under `.claude/skills`. Both use `SKILL.md` as the entry point.

The Vercel `skills` CLI is useful for discovery and ad-hoc installation. Its update lock tracks installed skill origins and content hashes, but it is not a complete declaration that can always rebuild missing installations. This manager therefore owns the desired state while remaining compatible with standard Skill directories.

## Decision

The repository has three distinct states:

1. `registry/skills.yaml` declares sources, skills, enablement, and agent targets.
2. `.skill-manager/lock.yaml` records the reviewed Git commit for each third-party source.
3. `.skill-manager/managed-links.json` records only links created by this manager.

Local sources live in `skills/`. Third-party Git worktrees live in `vendors/` and may be Git submodules. Agent adapters translate a resolved skill into an installation path. The synchronizer creates symlinks and reconciles only links recorded in its private manifest.

## Safety invariants

- Registry paths cannot escape their source root.
- A skill is installable only if `SKILL.md` exists.
- Existing non-matching files, directories, and links are never overwritten.
- Stale links are removed only when the on-disk symlink still matches the previously recorded target.
- `check` runs fetch/read operations only.
- `update` requires one named source, refuses dirty worktrees, requires fast-forward ancestry, checks out the reviewed candidate, updates the lock atomically, then syncs.
- Tests install only into temporary home directories.

## Extension points

- Add an agent by implementing `AgentAdapter`; registry and source logic remain unchanged.
- Add a source type behind a source abstraction and extend schema validation explicitly.
- Windows support can replace the symlink installer without changing registry resolution.

## Deliberate omissions in v0.1

No GUI/TUI, marketplace, account system, cloud sync, background upgrades, custom Skill format, or implicit bulk update.
