# Agent Skills Manager

[English](README.md) | 简体中文

一个轻量、保守、以 CLI 为主的 registry，在 Codex、Claude Code、Kimi Code、Pi 和 OpenCode 之间，将个人与第三方的 Agent Skills 维护为单一事实来源。

核心模型：

```text
Registry (what exists) → Lock (reviewed vendor commits) → Sync (which agents see it)
```

管理器保留标准的 `SKILL.md` 布局。它不会把 skills 复制进 agent 目录，而是创建 symlink，并且只记录它自己拥有的链接。

## 为什么存在

- 在 `skills/` 中维护个人 skills。
- 在 `vendors/` 中维护第三方 Git sources，最好以 submodule 形式。
- 在 `.skill-manager/lock.yaml` 中锁定已审阅的 vendor commit。
- 在 `registry/skills.yaml` 中声明启用状态与 agent targets。
- 以确定性的方式重建 Codex、Claude Code、Kimi Code、Pi 和 OpenCode 的安装。
- 在更新可执行的 skill 内容之前，先检查上游变更。

边界与安全不变量的说明见[架构决策](docs/architecture.md)。

驱动这套接口、可在任意工作目录使用的 Skill，见 [`skills/manage-agent-skills`](skills/manage-agent-skills/README.zh-CN.md)。

## 环境要求

- Node.js 20+
- Git
- macOS 或 Linux（Windows 尚未完全支持）

## 开发安装

```bash
npm install
npm run cli -- list
```

没有构建步骤。TypeScript 源码就是唯一产物：`npm run cli` 通过 `tsx` 运行它，打包 Skill 的每个入口也一样。新 clone 的仓库这两条命令都不需要——Skill 的入口会在首次使用时自动安装缺失的依赖和 vendor submodule。

## 仓库结构

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

## 配置 registry

`registry/skills.yaml` 即期望状态：

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

已提交的 registry 只承载**全局**安装。每个 Agent 的全局目录相互独立，因此 `targets` 可以自由选择 Agent；`agents: ["*"]` 表示全部 Agent。一个 Skill 可以有 `targets: []`——它已注册、可用，只是没有安装到任何全局位置。

**项目级安装属于本机状态，绝不提交。** 不同设备上的项目各不相同，即便项目相同，路径也可能不同，因此集中记录只会给其他每台机器留下一条无法执行的条目。它们存放在被忽略的 `.skill-manager/projects.local.yaml` 中，该文件记录每个项目的本地 checkout 路径以及安装到其中的 Skills：

```bash
agent-skills install review --scope project --project storefront --project-path ../storefront
agent-skills project list
```

Skill 本身、它的来源和锁定的 commit 仍然会被提交，因此内容审阅与 lock 的保证不受影响——只有安装位置是本地的。这一取舍由此明确：项目安装不会随设备迁移，新设备需要重新安装。一台机器上同一个项目可以绑定多个 checkout（Git worktree 或第二个 clone），每个 checkout 都会收到链接；用 `agent-skills project bind storefront ../storefront-worktree` 添加。

Codex、Kimi Code、Pi 和 OpenCode 在项目中共用同一个 `.agents/skills/<name>` 链接（只有 Claude Code 使用独立的 `.claude/skills/<name>`），因此只给这四个中的某一个安装时，其余几个在物理上也会看到该 Skill；安装计划会把这些顺带看到该 Skill 的 agent 列为 `impliedAgents`。

若项目安装对应的 checkout 未绑定，`sync` 会在改动任何链接之前失败。Git worktree 中的项目链接会精确写入该 worktree 本地的 `.git/info/exclude`；受版本控制的 `.gitignore` 文件永远不会被修改。非 Git 项目目录同样支持，只是不做 exclude 管理。

对应的 lock 文件记录已审阅的 vendor 版本：

```yaml
sources:
  anthropic:
    commit: "a84c619..."
```

将 vendor 仓库添加到约定路径：

```bash
git submodule add https://github.com/anthropics/skills.git vendors/anthropic
git -C vendors/anthropic checkout --detach a84c619...
```

每个已注册的 skill 目录都必须包含 `SKILL.md`。registry 中的路径被限制在其 source 根目录内。

## 命令

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

- `list` 为每个解析出的 target 显示一行，包括 scope、project、agents 和 source 路径。
- `show` 打印一个 Skill 的 frontmatter 标题与描述、source、锁定的 commit、路径、启用状态以及每个 target；`--json` 以机器可读的形式输出同样的内容。
- `sync` 为启用的 skills 对账 symlink。`--skill` 将对账限制在单个 Skill，同时保留所有其他受管链接。
- `install` 注册或扩展一个 Skill 的安装，可选地导入并锁定新的 Git source，支持无副作用的 `--dry-run --json` 计划模式。全局安装会写入 registry；项目安装只写入本机状态，因此除非同时导入新 source，不会产生任何被跟踪的变更。项目安装接受 `--agents <agent|*>`；任何与所选 agent 共用项目 skills 目录的 agent，都会被列入计划的 `impliedAgents`。
- `remove` 删除匹配的安装记录及其受管链接，但保留 Skill；`--scope project` 只修改本机状态，`--all` 同时清除全局 targets 和本机已知的所有项目安装。最终没有任何安装位置的 Skill 会被禁用。
- `delete <skill>` 删除 Skill 记录、其所有受管链接以及归其所有的本地内容。它拒绝删除含有 modified、untracked 或 ignored 内容的本地 Skill——这些路径可能是用户数据，因此错误信息会列出它们——同时，独占的第三方 source 也会一并删除，而被其他已注册 Skill 共用的 source 会保留。
- `delete --source <id>` 显式删除一个第三方 source、由它注册的每个 Skill、对应的 lock、submodule、vendor checkout、链接以及受管的 Git exclude 条目。它拒绝 `local`，拒绝含有 modified 或 untracked 内容的 vendor，并把未初始化的 submodule 视为干净。vendor 内的 ignored 内容（可重建的构建产物）会随之删除，并在计划的 `ignoredPaths` 中报告。
- `publish` 执行一个变更类命令，将其跟踪的变更提交到 `main`，对账链接，并在未传 `--no-push` 时推送。校验只针对发生变更的路径，提交前失败会恢复干净的 `main`，且不触碰任何链接。
- `doctor` 校验 registry/lock 文件、projects、sources、`SKILL.md` 文件、commits、链接以及受管的 Git excludes。
- `check` 获取远端 refs 并报告候选版本，不改变 working tree 或 lock。
- `diff` 显示锁定 commit 与上游候选 commit 之间的变更，范围限定在相关的 skill 路径内。
- `update` 只更新一个干净的 Git source，写入其 lock，并执行 sync；`--dry-run --json` 返回计划的跟踪变更，不触碰 tree 或 lock。
- `enable` / `disable` 翻转一个 Skill 的启用标志，返回包含被跟踪 registry 变更的计划，默认执行 sync；`--dry-run` / `--json` 用于查看计划，`--no-sync` 延后对账。
- `project bind` 为一个逻辑项目添加本设备的绝对路径，保留已绑定到该项目的任何 checkout；已被绑定到其他项目的目录会被拒绝。`project unbind <project> [path]` 移除一个 checkout，省略路径时移除全部 checkout；该项目仍存在受管链接时拒绝执行。

这些命令通过 `npm run cli -- <command>` 运行，或通过打包 Skill 的 `scripts/agent-skills.sh`——后者会自行定位仓库。在 registry 仓库之外运行时，使用 `--root <path>` 或 `AGENT_SKILLS_ROOT`。

将已注册的 Skill 全局安装到某个 Agent：

```bash
agent-skills install herdr --scope global --agents codex
```

导入新的第三方 Skill 并安装到指定项目：

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

打包的 `manage-agent-skills` Skill 会探查 sources，拉取仅名称匹配的候选前先请求确认，调用本 CLI 接口，并在对账 symlink 之前，把被跟踪的 install、remove 或 delete 变更直接提交到 `main`。传入 `--no-push` 可让 commit 只留在本地。它的 `agent-skills.sh` 入口会拒绝变更类子命令（`install`、`remove`、`delete`、`update`、`enable`、`disable`）——这些命令会留下未提交的、被跟踪的 registry 与 lock 文件——并引导用户改用专门的 `install-skill.sh` / `change-skill.sh` 启动器，后者会在 `main` 上提交；只读与纯本地命令则直接放行。

## 安装位置

内置 adapters 使用：

| Agent | Global skill directory | Project skill directory |
| --- | --- | --- |
| Codex | `~/.agents/skills` | `.agents/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Kimi Code | `~/.kimi-code/skills` | `.agents/skills` |
| Pi Coding Agent | `~/.pi/agent/skills` | `.agents/skills` |
| OpenCode | `~/.config/opencode/skills` | `.agents/skills` |

为了安全实验和自动化测试，可将所有 adapter 重定向：

```bash
AGENT_SKILLS_HOME="$(mktemp -d)" npm run cli -- sync
```

## 示例工作流

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

第三方 Skills 可能包含可执行脚本和操作说明。执行 `update` 前请先审阅上游 diff；本工具刻意不提供静默或批量后台升级。

## 开发

```bash
npm run typecheck
npm test
```

测试使用临时 home 与项目目录，验证幂等性、安全清理、路径约束、本地 Git excludes 以及只读的 update 检查。

## 与 `npx skills` 的关系

用 `npx skills` 做生态发现和快速导入。用本仓库作为持久化的期望状态与版本审阅层。Agent Skills Manager 不会重新定义开放的 Skill 格式，也不会取代发现市场。

## 许可证

MIT
