# Manage Agent Skills

English | [简体中文](README.zh-CN.md)

`manage-agent-skills` is the Skill that ships with — and manages — the central `agent-skills` repository. Through it, one registry drives Skill installations for Codex, Claude Code, Kimi Code, Pi, and OpenCode at once: personal Skills from `skills/`, third-party Skills pinned to reviewed commits under `vendors/`, global installs that follow you across devices, and project installs that stay on the machine where you made them.

`SKILL.md` is the operating manual an agent reads while executing this Skill. This README is for people: what the pieces are, how to drive them by hand, and why they are shaped this way.

## Entry points

Three scripts under `scripts/` are the whole interface. Run them from anywhere; they locate the central repository themselves.

| Entry point | What it owns |
| --- | --- |
| `scripts/agent-skills.sh` | Read-only and purely local commands: `list`, `show`, `sync`, `doctor`, `check`, `diff`, `project`. It refuses every subcommand that writes committed state and names the launcher that owns it. |
| `scripts/install-skill.sh` | Installs. Validates the request, commits tracked changes on `main`, reconciles symlinks. |
| `scripts/change-skill.sh` | Every other mutation: `--action remove`, `delete`, `update`, `enable`, `disable`. Same publish discipline as the installer. |

Inspecting and reconciling:

```bash
skills/manage-agent-skills/scripts/agent-skills.sh list
skills/manage-agent-skills/scripts/agent-skills.sh show herdr --json
skills/manage-agent-skills/scripts/agent-skills.sh sync
skills/manage-agent-skills/scripts/agent-skills.sh doctor
skills/manage-agent-skills/scripts/agent-skills.sh check anthropic
skills/manage-agent-skills/scripts/agent-skills.sh diff anthropic
skills/manage-agent-skills/scripts/agent-skills.sh project list
skills/manage-agent-skills/scripts/agent-skills.sh project bind storefront ~/work/storefront-worktree
skills/manage-agent-skills/scripts/agent-skills.sh project unbind storefront
```

Installing. `--skill`, `--source-url`, and `--scope` are required; `--agents` is required for `--scope global` and defaults to `"*"` for `--scope project`:

```bash
# one agent, globally
skills/manage-agent-skills/scripts/install-skill.sh \
  --skill herdr \
  --source-url https://github.com/owner/herdr \
  --scope global --agents claude

# the current project, every agent — run it from the project checkout;
# --project is inferred from the git remote when omitted
skills/manage-agent-skills/scripts/install-skill.sh \
  --skill review \
  --source-url https://github.com/owner/skills/tree/main/skills/review \
  --scope project
```

A Skill that is not registered yet also takes `--repo`, `--source-id`, `--path`, and optionally `--ref` to import and pin its source.

Changing state. `--action` takes the manager's own command names:

```bash
# unlink from one scope
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill review --scope project
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill herdr --scope global --agents claude
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill herdr --all

# delete a Skill, or a whole third-party source (exactly one of --skill / --source)
skills/manage-agent-skills/scripts/change-skill.sh --action delete --skill review
skills/manage-agent-skills/scripts/change-skill.sh --action delete --source owner-skills

# upgrade a pinned source after reviewing check/diff
skills/manage-agent-skills/scripts/change-skill.sh --action update --source anthropic

# park a Skill without deleting any target, and bring it back
skills/manage-agent-skills/scripts/change-skill.sh --action disable --skill review
skills/manage-agent-skills/scripts/change-skill.sh --action enable --skill review
```

Both launchers accept `--no-push` to keep the commit local. Neither takes a commit title: the installer asks the registry whether the Skill is already known and names the commit accordingly, so a run that widens an existing installation is not recorded as adding one.

## Why the guard exists

`install`, `remove`, `delete`, `update`, `enable`, and `disable` rewrite the git-tracked `registry/skills.yaml` and `.skill-manager/lock.yaml`. Run them bare and the files change without a commit, the central repository goes dirty, and every later launcher run fails with "central agent-skills repository has uncommitted changes" — the tool deadlocks itself. `agent-skills.sh` therefore refuses those subcommands outright and points at the launcher that commits the change on `main` as part of the operation.

## The publishing model

The central repository holds your own configuration, not shared code awaiting review, so `main` is the only branch that ever represents it: the launchers commit straight to `main` and never open a branch or a pull request.

Each run applies changes in one order — registry, lock, and vendor edits first, validation, the commit, and only then symlink reconciliation. A failure before the commit has not touched a single link and restores a clean `main`, so a failed run needs no Git surgery. Validation is scoped to what changed: a registry-only edit proves the registry still resolves, while edits under the manager's own source run the full check. After committing, the launcher pushes `main` unless `--no-push` was passed; a rejected push is a warning, not a failure, because the commit and the links already agree locally.

## Global vs project scope

- A **global** install is recorded in the committed registry and follows you to every device: `git pull` plus `agent-skills.sh sync` recreates it anywhere.
- A **project** install is machine state. It lives in the git-ignored `.skill-manager/projects.local.yaml`, produces no commit, and does not travel — a new device needs the project install run once there. This trade-off is deliberate: projects, and their paths, genuinely differ between machines, so syncing them would only hand every other machine an entry it cannot act on.
- The Skill's content, source, and locked commit are committed either way. Only "which directory on this machine also carries the Skill" is local, so the review and lock guarantees are unaffected.
- Inside a project, Codex, Kimi Code, Pi, and OpenCode share `.agents/skills`; only Claude Code has its own `.claude/skills`. Installing for exactly one of those four is therefore physically impossible — every agent sharing the directory sees the Skill — and the install plan reports the extra viewers as `impliedAgents`.

## Starting on a new machine

Clone the repository and run any entry point; there is no setup step. The scripts install missing npm dependencies and initialize vendor submodules on first use, then run the TypeScript sources directly — no build required. This cannot be delegated to a Git hook: hooks live in `.git/hooks`, which is never cloned, so a hook cannot help the one case that needs help most — a fresh clone on a new machine.

## The scripts at a glance

| File | Role |
| --- | --- |
| `agent-skills.sh` | Read-only/local entry point; refuses mutating subcommands first — costing nothing — then bootstraps a fresh clone and forwards the rest to the CLI. |
| `install-skill.sh` | Install launcher shell wrapper; records your working directory before entering the central repository. |
| `install-skill.mjs` | Validates install flags, prepares the central repository, and hands the install to the manager's publish path. |
| `change-skill.sh` | Change launcher shell wrapper for `remove` / `delete` / `update` / `enable` / `disable`. |
| `change-skill.mjs` | Validates change flags per action and maps them to manager operands plus a commit title. |
| `bootstrap.mjs` | Shared pre-flight: refuses a dirty tree, fast-forwards to `origin/main`, installs dependencies, initializes submodules, re-executes the launcher when the pull changed it. |
| `install-helpers.mjs` | Shared helpers: process running, argument parsing, logical project ID inference from Git remotes. |
| `change-helpers.mjs` | The change launcher's per-action flag validation and operand/commit-title mapping. |
| `run-with-node.sh` | Finds a Node.js 20+ runtime — `AGENT_SKILLS_NODE`, `PATH`, nvm, Volta — and execs the real entry point with it. |
