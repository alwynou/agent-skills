# Agent Skills Manager

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

## Requirements

- Node.js 20+
- Git
- macOS or Linux (Windows is not yet fully supported)

## Install for development

```bash
npm install
npm run build
npm link
```

This exposes the `agent-skills` command. You can also run commands without linking:

```bash
npm run dev -- list
```

## Repository layout

```text
agent-skills/
├── skills/                         # skills you maintain
├── vendors/                        # third-party Git repos/submodules
├── registry/skills.yaml            # desired state
├── .skill-manager/
│   ├── lock.yaml                   # reviewed source commits
│   └── managed-links.json          # links this tool may reconcile
├── src/
│   ├── agents/                     # Codex and Claude adapters
│   ├── core/                       # orchestration, types, safety
│   ├── git/                        # Git process abstraction
│   ├── installer/                  # conservative symlink reconciler
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
    agents:
      - "*"

  pdf:
    source: anthropic
    path: skills/pdf
    enabled: true
    agents:
      - codex
      - claude
```

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
agent-skills sync
agent-skills doctor
agent-skills check [source]
agent-skills diff <source>
agent-skills update <source>
agent-skills enable <skill>
agent-skills disable <skill>
```

- `list` shows resolved skills, sources, enablement, agents, and paths.
- `sync` reconciles symlinks for enabled skills. It never overwrites unknown content.
- `doctor` validates registry/lock files, sources, `SKILL.md` files, commits, and links.
- `check` fetches remote refs and reports candidates without changing working trees or locks.
- `diff` shows changes between the locked and upstream candidate commit, scoped to relevant skill paths.
- `update` updates exactly one clean Git source, writes its lock, and syncs.
- `enable` / `disable` edit the registry; run `sync` to apply the new state.

Use `--root <path>` or `AGENT_SKILLS_ROOT` when running outside the registry repository.

## Installation destinations

The built-in adapters use:

| Agent | Global skill directory |
| --- | --- |
| Codex | `~/.agents/skills` |
| Claude Code | `~/.claude/skills` |
| Kimi Code | `~/.kimi-code/skills` |
| Pi Coding Agent | `~/.pi/agent/skills` |
| OpenCode | `~/.config/opencode/skills` |

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
npm run build
```

Tests use temporary home directories and verify idempotency, safe cleanup, path confinement, and read-only update checks.

## Relationship to `npx skills`

Use `npx skills` for ecosystem discovery and quick imports. Use this repository as the durable desired-state and version-review layer. Agent Skills Manager does not redefine the open Skill format or replace discovery marketplaces.

## License

MIT
