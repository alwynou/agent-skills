# Architecture decision: Registry → Lock → Sync

Status: accepted for v0.1

## Context

Agent Skills already have a portable unit: a directory containing `SKILL.md` plus optional scripts, references, and assets. This project should manage those units, not invent a competing skill format.

Codex discovers user skills under `~/.agents/skills` and repository skills under `.agents/skills`; its official documentation explicitly supports symlinked skill directories. Claude Code discovers personal skills under `~/.claude/skills` and project skills under `.claude/skills`. Kimi Code, Pi, and OpenCode have their own global skill directories and also support common Agent Skills locations. All supported agents use `SKILL.md` as the entry point.

The Vercel `skills` CLI is useful for discovery and ad-hoc installation. Its update lock tracks installed skill origins and content hashes, but it is not a complete declaration that can always rebuild missing installations. This manager therefore owns the desired state while remaining compatible with standard Skill directories.

## Decision

The manager has four distinct states:

1. `registry/skills.yaml` declares sources, portable logical project names, skills, enablement, global Agent targets, and project-wide targets.
2. `.skill-manager/lock.yaml` records the reviewed Git commit for each third-party source.
3. `.skill-manager/projects.local.yaml` binds logical projects to absolute paths on one device and is not committed.
4. `.skill-manager/managed-links.json` records only links created by this manager, including every Agent consuming a shared link, and is not committed.

The managed-links manifest is version 3. Version 2 manifests are read as single-consumer records and rewritten as v3 on the next successful sync.

Local sources live in `skills/`. Third-party Git worktrees live in `vendors/` and may be Git submodules. Agent adapters translate global targets into Agent-specific paths. Project targets are shared by every supported Agent: Codex, Kimi Code, Pi, and OpenCode consume `.agents/skills`, while Claude Code receives a `.claude/skills` compatibility link. The synchronizer merges consumers of the same path and reconciles only links recorded in its private, versioned manifest.

New third-party sources are inspected in a temporary checkout before the registry is mutated, then added as Git submodules and pinned in the lock. A selective synchronization partitions the managed manifest by Skill: it reconciles the selected Skill while retaining all other link ownership and Git exclude entries unchanged.

Every skill declares `targets`; there is no implicit global shorthand. Project targets use `agents: ["*"]` because project Skills are intentionally cross-Agent. Project paths never appear in the portable registry. Each device establishes its own absolute bindings with `project bind`, so cloning the registry on a machine with a different directory layout requires no repository edit.

## Safety invariants

- Registry paths cannot escape their source root.
- Skill names cannot escape an agent's skill directory.
- Project bindings must be absolute, must exist when bound or synced, cannot be filesystem roots, and cannot alias another logical project.
- An unbound enabled project target aborts sync before any link or Git exclude mutation.
- A skill is installable only if `SKILL.md` exists.
- Existing non-matching files, directories, and links are never overwritten.
- Dry-run installation may fetch into a temporary directory but cannot modify registry, lock, submodules, bindings, links, or Git excludes.
- Stale links are removed only when the on-disk symlink still matches the previously recorded target.
- A project cannot be unbound while its links remain in the managed-links manifest.
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
