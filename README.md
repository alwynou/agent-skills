# Agent Skills Manager

English | [简体中文](README.zh-CN.md)

A small, conservative, CLI-first registry for keeping personal and third-party Agent Skills as one source of truth across Codex, Claude Code, Kimi Code, Pi, and OpenCode.

The core model is:

```text
Registry (what exists) → Lock (reviewed vendor commits) → Sync (which agents see it)
```

The manager preserves the standard `SKILL.md` layout. It does not copy skills into agent directories; it creates symlinks and records only the links it owns.

## Why this exists

- Keep personal skills in `skills/`.
- Keep third-party Git sources in `vendors/`, preferably as submodules.
- Pin reviewed vendor commits in `.skill-manager/lock.yaml`.
- Declare enablement and agent targets in `registry/skills.yaml`.
- Rebuild Codex, Claude Code, Kimi Code, Pi, and OpenCode installations deterministically.
- Inspect upstream changes before updating executable skill content.

See [the architecture decision](docs/architecture.md) for boundaries and safety invariants.

See [`skills/manage-agent-skills`](skills/manage-agent-skills/README.md) for the Skill that drives this interface from any working directory.

## Requirements

- Node.js 20+
- Git
- macOS or Linux (Windows is not yet fully supported)

## Install for development

```bash
npm install
npm run dev -- list
```

There is no build step. The TypeScript sources are the only artifact: `npm run dev` runs them through `tsx`, and so does every entry point of the bundled Skill. A fresh clone needs neither command — the Skill's entry points install missing dependencies and vendor submodules on first use.

## Repository layout

```text
agent-skills/
├── skills/                         # skills you maintain
├── vendors/                        # third-party Git repos/submodules
├── registry/skills.yaml            # desired state
├── .skill-manager/
│   ├── lock.yaml                   # reviewed source commits
│   ├── managed-links.json          # machine-local links this tool may reconcile
│   └── projects.local.yaml         # machine-local project path bindings
├── src/
│   ├── agents/                     # supported agent adapters
│   ├── command/                    # argument parsing, mutation dispatch
│   ├── core/                       # orchestration, types, safety
│   ├── git/                        # Git process abstraction
│   ├── installer/                  # conservative symlink reconciler
│   ├── publish/                    # commit-on-main publishing flow
│   ├── registry/                   # load, validate, resolve
│   └── sources/                    # Git source behavior
├── tests/
├── AGENTS.md
└── package.json
```

## Configure the registry

`registry/skills.yaml` is the desired state:

```yaml
sources:
  anthropic:
    type: git
    repo: https://github.com/anthropics/skills.git

skills:
  builder:
    source: local
    path: skills/builder
    enabled: true
    targets:
      - scope: global
        agents:
          - "*"

  pdf:
    source: anthropic
    path: skills/pdf
    enabled: true
    targets:
      - scope: global
        agents:
          - codex
          - claude

```

The committed registry carries **global** installations only. Every Agent's global directory is independent, so `targets` selects Agents freely; use `agents: ["*"]` for all of them. A Skill may have `targets: []` — it is registered and available, but installed globally nowhere.

**Project installations are machine state and are never committed.** Projects differ between devices, and their paths differ even when they do not, so recording them centrally would give every other machine an entry it cannot act on. They live in the ignored `.skill-manager/projects.local.yaml`, which holds each project's local checkout paths and the Skills installed into it:

```bash
agent-skills install review --scope project --project storefront --project-path ../storefront
agent-skills project list
```

The Skill itself, its source, and its pinned commit are still committed, so the reviewed-content and lock guarantees are unaffected — only the placement is local. The trade this makes explicit: a project installation does not travel, and a new device installs it again. One project may be bound to several checkouts on a machine — Git worktrees or a second clone — and each receives the links; add one with `agent-skills project bind storefront ../storefront-worktree`.

Codex, Kimi Code, Pi, and OpenCode all read the same `.agents/skills/<name>` link in a project (only Claude Code has a separate `.claude/skills/<name>`), so installing for one of those four physically exposes the Skill to the others; the install plan lists them as `impliedAgents`.

A project installation whose checkout is unbound makes `sync` fail before any link changes. Project links in Git worktrees are added precisely to the worktree's local `.git/info/exclude`; tracked `.gitignore` files are never changed. Non-Git project directories are supported without exclude management.

The matching lock file records the reviewed vendor revision:

```yaml
sources:
  anthropic:
    commit: "a84c619..."
```

Add the vendor repository at the conventional path:

```bash
git submodule add https://github.com/anthropics/skills.git vendors/anthropic
git -C vendors/anthropic checkout --detach a84c619...
```

Every registered skill directory must contain `SKILL.md`. Registry paths are constrained to their source root.

## Commands

```bash
agent-skills list
agent-skills show <skill> [--json]
agent-skills sync [--skill <name>]
agent-skills install <skill> --scope global --agents <agent|*> [options]
agent-skills install <skill> --scope project --project <id> --project-path <path> [--agents <agent|*>] [options]
agent-skills remove <skill> --scope global --agents <agent|*> [--dry-run] [--json] [--no-sync]
agent-skills remove <skill> --scope project --project <id> [--dry-run] [--json] [--no-sync]
agent-skills remove <skill> --all [--dry-run] [--json] [--no-sync]
agent-skills delete <skill> [--dry-run] [--json] [--no-sync]
agent-skills delete --source <source-id> [--dry-run] [--json] [--no-sync]
agent-skills doctor
agent-skills check [source]
agent-skills diff <source>
agent-skills update <source> [--dry-run] [--json] [--no-sync]
agent-skills enable <skill> [--dry-run] [--json] [--no-sync]
agent-skills disable <skill> [--dry-run] [--json] [--no-sync]
agent-skills publish --title <commit-title> [--no-push] -- <mutating command> [args...]
agent-skills project list
agent-skills project bind <project> <path>
agent-skills project unbind <project> [path]
```

- `list` shows one row per resolved target, including scope, project, agents, and source path.
- `show` prints one Skill's frontmatter title and description, source, locked commit, path, enabled state, and every target; `--json` emits the same detail machine-readably.
- `sync` reconciles symlinks for enabled skills. `--skill` limits reconciliation to one Skill while preserving every other managed link.
- `install` registers or extends a Skill installation, optionally imports and pins a new Git source, and supports mutation-free `--dry-run --json` planning. A global install writes the registry; a project install writes only machine state, so it produces no tracked change unless it also imports a new source. Project installs accept `--agents <agent|*>`; any agent that shares a project skills directory with the selection is listed in the plan's `impliedAgents`.
- `remove` deletes matching installation records and their managed links while retaining the Skill; `--scope project` edits machine state only, and `--all` clears both the global targets and every project installation this machine knows about. A Skill left installed nowhere is disabled.
- `delete <skill>` removes the Skill record, all of its managed links, and owned local content. It refuses local Skills with modified, untracked, or ignored content — those paths may be user data, so the error lists them — while an exclusive third-party source is removed too, and a source shared by other registered Skills is retained.
- `delete --source <id>` explicitly removes a third-party source, every Skill registered from it, its lock, submodule, vendor checkout, links, and managed Git exclude entries. It refuses `local`, refuses vendors with modified or untracked content, and treats uninitialized submodules as clean. Ignored content inside the vendor (rebuildable build output) is deleted along with it and reported in the plan's `ignoredPaths`.
- `publish` runs one mutating command, commits its tracked changes on `main`, reconciles the links, and pushes unless `--no-push` is passed. Validation is scoped to the changed paths, and a failure before the commit restores a clean `main` without touching a link.
- `doctor` validates registry/lock files, projects, sources, `SKILL.md` files, commits, links, and managed Git excludes.
- `check` fetches remote refs and reports candidates without changing working trees or locks.
- `diff` shows changes between the locked and upstream candidate commit, scoped to relevant skill paths.
- `update` updates exactly one clean Git source, writes its lock, and syncs; `--dry-run --json` returns the plan's tracked changes without touching the tree or lock.
- `enable` / `disable` flip one Skill's enabled flag, return a plan with the tracked registry change, and sync by default; `--dry-run` / `--json` inspect the plan, `--no-sync` defers reconciliation.
- `project bind` adds this device's absolute path for a logical project, keeping any checkout already bound to it; a directory bound to a different project is refused. `project unbind <project> [path]` drops one checkout, or every checkout when the path is omitted, and refuses while that project still has managed links.

Run these through `npm run dev -- <command>`, or through the bundled Skill's `scripts/agent-skills.sh`, which locates the repository for you. Use `--root <path>` or `AGENT_SKILLS_ROOT` when running outside the registry repository.

Install an already registered Skill into one Agent globally:

```bash
agent-skills install herdr --scope global --agents codex
```

Import a new third-party Skill and install it into a named project:

```bash
agent-skills install example \
  --repo https://github.com/owner/skills.git \
  --source-id owner-skills \
  --path skills/example \
  --scope project \
  --agents codex \
  --project owner-app \
  --project-path /absolute/path/to/app
```

The bundled `manage-agent-skills` Skill discovers sources, asks for confirmation before pulling name-only matches, invokes this interface, and commits tracked install, remove, or delete changes straight onto `main` before reconciling the symlinks. Pass `--no-push` to keep the commit local. Its `agent-skills.sh` entry point refuses the mutating subcommands (`install`, `remove`, `delete`, `update`, `enable`, `disable`) — those would leave the tracked registry and lock files dirty without committing — and directs each to the dedicated `install-skill.sh` / `change-skill.sh` launchers, which commit on `main`; read-only and purely local commands pass straight through.

## Installation destinations

The built-in adapters use:

| Agent | Global skill directory | Project skill directory |
| --- | --- | --- |
| Codex | `~/.agents/skills` | `.agents/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Kimi Code | `~/.kimi-code/skills` | `.agents/skills` |
| Pi Coding Agent | `~/.pi/agent/skills` | `.agents/skills` |
| OpenCode | `~/.config/opencode/skills` | `.agents/skills` |

For safe experiments and automated tests, redirect all adapters:

```bash
AGENT_SKILLS_HOME="$(mktemp -d)" npm run dev -- sync
```

## Example workflow

```bash
# inspect desired state and health
agent-skills list
agent-skills doctor

# install/reconcile links
agent-skills sync

# inspect one vendor update without upgrading
agent-skills check anthropic
agent-skills diff anthropic

# only after reviewing the diff
agent-skills update anthropic
```

Third-party Skills can contain executable scripts and operational instructions. Review upstream diffs before `update`; this tool intentionally has no silent or bulk background upgrade.

## Development

```bash
npm run typecheck
npm test
```

Tests use temporary home and project directories and verify idempotency, safe cleanup, path confinement, local Git excludes, and read-only update checks.

## Relationship to `npx skills`

Use `npx skills` for ecosystem discovery and quick imports. Use this repository as the durable desired-state and version-review layer. Agent Skills Manager does not redefine the open Skill format or replace discovery marketplaces.

## License

MIT
