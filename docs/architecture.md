# Architecture decision: Registry → Lock → Sync

Status: accepted for v0.1

## Context

Agent Skills already have a portable unit: a directory containing `SKILL.md` plus optional scripts, references, and assets. This project should manage those units, not invent a competing skill format.

Codex discovers user skills under `~/.agents/skills` and repository skills under `.agents/skills`; its official documentation explicitly supports symlinked skill directories. Claude Code discovers personal skills under `~/.claude/skills` and project skills under `.claude/skills`. Kimi Code, Pi, and OpenCode have their own global skill directories and also support common Agent Skills locations. All supported agents use `SKILL.md` as the entry point.

The Vercel `skills` CLI is useful for discovery and ad-hoc installation. Its update lock tracks installed skill origins and content hashes, but it is not a complete declaration that can always rebuild missing installations. This manager therefore owns the desired state while remaining compatible with standard Skill directories.

## Decision

The repository has three distinct states:

1. `registry/skills.yaml` declares sources, named projects, skills, enablement, and global/project agent targets.
2. `.skill-manager/lock.yaml` records the reviewed Git commit for each third-party source.
3. `.skill-manager/managed-links.json` records only links created by this manager.

Local sources live in `skills/`. Third-party Git worktrees live in `vendors/` and may be Git submodules. Agent adapters translate a resolved skill target into an agent-specific global or project installation path. The synchronizer creates symlinks and reconciles only links recorded in its private, versioned manifest.

Existing `agents` entries remain a global-target shorthand. The `targets` form can declare global and project placements, including multiple named projects. Relative project paths resolve from the registry repository; absolute paths are accepted for machine-specific layouts.

## Safety invariants

- Registry paths cannot escape their source root.
- Skill names cannot escape an agent's skill directory.
- Project roots must exist before links are created and cannot be filesystem roots.
- A skill is installable only if `SKILL.md` exists.
- Existing non-matching files, directories, and links are never overwritten.
- Stale links are removed only when the on-disk symlink still matches the previously recorded target.
- Git projects receive exact managed entries in `.git/info/exclude`; unrelated exclude content and occupied user paths are never hidden or rewritten.
- `check` runs fetch/read operations only.
- `update` requires one named source, refuses dirty worktrees, requires fast-forward ancestry, checks out the reviewed candidate, updates the lock atomically, then syncs.
- Tests install only into temporary home and project directories.

## Extension points

- Add an agent by implementing `AgentAdapter`; registry and source logic remain unchanged.
- Add a source type behind a source abstraction and extend schema validation explicitly.
- Windows support can replace the symlink installer without changing registry resolution.

## Deliberate omissions in v0.1

No GUI/TUI, marketplace, account system, cloud sync, background upgrades, custom Skill format, or implicit bulk update.
