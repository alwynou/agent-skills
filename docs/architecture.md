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
3. `.skill-manager/projects.local.yaml` binds each logical project to one or more absolute paths on one device and is not committed. A single logical project may be checked out several times on a machine — Git worktrees or a second clone — and every bound checkout receives that project's links.
4. `.skill-manager/managed-links.json` records only links created by this manager, including every Agent consuming a shared link, and is not committed.

The managed-links manifest is version 3. Version 2 manifests are read as single-consumer records and rewritten as v3 on the next successful sync.

Local sources live in `skills/`. Third-party Git worktrees live in `vendors/` and may be Git submodules. Agent adapters translate a Skill name plus an optional project root into an Agent-specific path. Inside a project, Codex, Kimi Code, Pi, and OpenCode all consume `.agents/skills`, while Claude Code receives a separate `.claude/skills` link. The synchronizer merges consumers of the same path and reconciles only links recorded in its private, versioned manifest.

New third-party sources are inspected in a temporary checkout before the registry is mutated, then added as Git submodules and pinned in the lock. A selective synchronization partitions the managed manifest by Skill: it reconciles the selected Skill while retaining all other link ownership and Git exclude entries unchanged.

Every enabled skill declares at least one target; there is no implicit global shorthand. A disabled Skill may retain an empty target list after its final installation is removed, and reinstalling it adds a target and enables it. Project targets select Agents exactly as global targets do, but the directory layout bounds what that selection can express: a Claude-only project target is exact, while selecting one Agent from the group sharing `.agents/skills` necessarily exposes the Skill to the whole group. The installation plan reports the additional viewers as `impliedAgents` rather than implying an isolation the filesystem cannot provide. Project paths never appear in the portable registry. Each device establishes its own absolute bindings with `project bind`, so cloning the registry on a machine with a different directory layout requires no repository edit.

`remove` changes desired installation state without deleting Skill content. `delete <skill>` removes the Skill from desired state and deletes content only when ownership is provable: a local Skill must be a clean, tracked, real directory under `skills/`, and a third-party vendor is removed only when no other registered Skill uses its source. `delete --source` is the explicit atomic boundary for removing a third-party source and all of its registered Skills. Selective sync accepts a now-missing Skill only for these reconciliation paths, so stale managed links and exact Git exclude entries can be cleaned while unrelated manifest state is preserved.

Ignored content is weighed by what deleting it would cost. Inside a local Skill it may be the user's own data, so deletion refuses and names the paths. Inside a vendor it is build output of a re-clonable upstream checkout, so deletion proceeds and reports the paths as `ignoredPaths`. Dirtiness is only ever read from an initialized vendor: an uninitialized submodule has no `.git`, holds no local work, and must never be judged by the central repository's own status.

`enable`, `disable`, and `update` mutate committed state, so they produce the same planned shape as `install` and `remove`: a dry run, a JSON plan listing `trackedChanges`, and an optional sync. `update` moves both the lock entry and the submodule gitlink, so both belong to one commit.

## Publishing boundary

The central repository holds the user's own configuration rather than reviewable shared code, so `main` is the only branch that ever represents it. The bundled `manage-agent-skills` launchers commit straight to `main` and never open a pull request; routing configuration through review would leave the machine's links and the committed registry disagreeing for as long as the review lasted.

Two kinds of state must therefore be ordered, not merely both applied. Registry, lock, and vendor edits are committed first; symlinks are reconciled only afterwards. A failure before the commit leaves the machine untouched and restores a clean `main`, which is the only ordering under which a failed run is recoverable without manual Git surgery. Validation is scoped to what changed, because a registry edit cannot break a build.

The generic CLI entry point is not a publishing path. It refuses every subcommand that writes committed state and names the launcher that owns it; without that boundary a bare `update` or `enable` would leave tracked files dirty and deadlock every later launcher run.

Publishing itself is a manager command, not launcher logic: `publish --title <t> -- <mutating command>` runs the mutation in-process and commits it. The launchers keep only what must exist before TypeScript does — locating a Node runtime, bringing the repository to `origin/main`, and re-executing themselves when that pull changed them. Every mutating command is parsed in exactly one place, so the plain and published paths cannot drift.

The launchers speak the manager's own vocabulary rather than inventing one: the same `--scope`, `--agents`, `--all`, and `--source` spellings, and `--action` values that are the manager's command names. They add only what the manager cannot know — the commit title, the source URL a Skill was confirmed from, and the working directory behind a project install. A second vocabulary would need a translation layer, and a translation layer is somewhere the two surfaces can disagree.

## Safety invariants

- Registry paths cannot escape their source root.
- Skill names cannot escape an agent's skill directory.
- Project bindings must be absolute, must exist when bound or synced, cannot be filesystem roots, and cannot alias another logical project; one project may hold several distinct checkouts.
- An unbound enabled project target aborts sync before any link or Git exclude mutation.
- A skill is installable only if `SKILL.md` exists.
- Existing non-matching files, directories, and links are never overwritten.
- Dry-run installation may fetch into a temporary directory but cannot modify registry, lock, submodules, bindings, links, or Git excludes.
- Stale links are removed only when the on-disk symlink still matches the previously recorded target.
- Removing or deleting a Skill preserves any link that a user has replaced and reports it as skipped.
- Local deletion refuses symlinks, shared paths, paths outside `skills/`, modified, untracked, or ignored content, and the self-managing `manage-agent-skills` Skill.
- Third-party source deletion refuses `local`, vendors holding modified or untracked content, missing vendors, and paths that are not tracked submodules under `vendors/`. An uninitialized submodule counts as clean, and ignored vendor content is removed with it.
- A checkout cannot be unbound while its links remain in the managed-links manifest.
- Git projects receive exact managed entries in `.git/info/exclude`; unrelated exclude content and occupied user paths are never hidden or rewritten.
- `check` runs fetch/read operations only.
- Publishing commits committed state before reconciling links, and a failure before that commit restores a clean `main` without having touched a single link.
- Only planned paths may be staged; a staged path outside the plan aborts the commit.
- The generic CLI entry point refuses every subcommand that writes committed state.
- `update` requires one named source, refuses dirty worktrees, requires fast-forward ancestry, checks out the reviewed candidate, updates the lock atomically, then syncs. A source already at its candidate is a no-op with nothing to commit.
- Tests install only into temporary home and project directories.

## Extension points

- Add an agent by implementing `AgentAdapter`; registry and source logic remain unchanged.
- Add a source type behind a source abstraction and extend schema validation explicitly.
- Windows support can replace the symlink installer without changing registry resolution.

## Deliberate omissions in v0.1

No GUI/TUI, marketplace, account system, cloud sync, background upgrades, custom Skill format, or implicit bulk update.
