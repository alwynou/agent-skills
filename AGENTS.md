# Agent instructions

This repository is a conservative local package manager for executable Agent Skills.

## Priorities

1. Never overwrite or delete a file/link that cannot be proven to be managed by this tool.
2. `check` may fetch remote refs, but must not change a vendor working tree or lock file.
3. `update` always requires one explicit source name and must refuse dirty vendor trees.
4. Tests that exercise agent installation must use `AGENT_SKILLS_HOME` or a temporary home. Never target the developer's real `~/.agents` or `~/.claude` directories.
5. Keep agent-specific paths behind `AgentAdapter`; keep source-specific behavior behind source classes.
6. Anything that writes committed state must go through a `manage-agent-skills` launcher, which commits before reconciling links. Never let the generic CLI entry point pass such a subcommand through.
7. The committed registry carries global installations only. Project installations are machine state in the ignored `.skill-manager/projects.local.yaml`; never move a project name, path, or target back into `registry/skills.yaml`, however convenient it looks. Projects and their paths differ per device, so a committed project record is one that every other machine can only fail to act on.
8. The launchers speak the manager's own vocabulary — the same `--scope`, `--agents`, `--all`, and `--source` spellings, and `--action` values that are its command names. Do not introduce a launcher-only alias; a second vocabulary needs a translation layer, and a translation layer is somewhere the two surfaces can disagree.
9. Entry points repair a fresh clone themselves — dependencies and vendor submodules. Do not reach for a Git hook: `.git/hooks` is never cloned, so a hook cannot help the one case that needs it.

## Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Full check: `npm run check`

There is no build step and no emitted output: `tsconfig.json` sets `noEmit`, and every entry point runs the TypeScript sources through `tsx`. Do not reintroduce one without a consumer that actually needs compiled output.

## Code conventions

- TypeScript ESM, strict mode, Node.js 20+.
- Prefer Node built-ins and small dependencies.
- Validate all registry and lock input before filesystem or Git mutations.
- Keep destructive behavior explicit, narrow, and covered by safety tests.
- Assert behavior, not source text. A test that greps a script for a string passes while the behavior rots; drive the real thing instead.
- Update `docs/architecture.md` when changing core boundaries or safety invariants.
- Keep the four READMEs in step when the interface changes: `README.md`, `README.zh-CN.md`, and the pair under `skills/manage-agent-skills/`. `SKILL.md` is the agent-facing operating manual; those READMEs are for people.
