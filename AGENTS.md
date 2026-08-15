# Agent instructions

This repository is a conservative local package manager for executable Agent Skills.

## Priorities

1. Never overwrite or delete a file/link that cannot be proven to be managed by this tool.
2. `check` may fetch remote refs, but must not change a vendor working tree or lock file.
3. `update` always requires one explicit source name and must refuse dirty vendor trees.
4. Tests that exercise agent installation must use `AGENT_SKILLS_HOME` or a temporary home. Never target the developer's real `~/.agents` or `~/.claude` directories.
5. Keep agent-specific paths behind `AgentAdapter`; keep source-specific behavior behind source classes.
6. Anything that writes committed state must go through a `manage-agent-skills` launcher, which commits before reconciling links. Never let the generic CLI entry point pass such a subcommand through.

## Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Build: `npm run build`
- Full check: `npm run check`

## Code conventions

- TypeScript ESM, strict mode, Node.js 20+.
- Prefer Node built-ins and small dependencies.
- Validate all registry and lock input before filesystem or Git mutations.
- Keep destructive behavior explicit, narrow, and covered by safety tests.
- Update `docs/architecture.md` when changing core boundaries or safety invariants.
