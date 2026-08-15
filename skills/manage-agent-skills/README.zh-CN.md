# Manage Agent Skills

[English](README.md) | 简体中文

`manage-agent-skills` 是中央 `agent-skills` 仓库自带、并用来管理这个仓库自身的那个 Skill。通过它，一份 registry 同时驱动 Codex、Claude Code、Kimi Code、Pi、OpenCode 五个 Agent 的 Skill 安装：`skills/` 下的个人 Skill、`vendors/` 下锁定在已 review commit 的第三方 Skill、跨设备跟随你的全局安装，以及只留在本机的项目级安装。

`SKILL.md` 是给执行这个 Skill 的 Agent 看的操作手册。这份 README 是给人看的：各部分是什么、如何手动使用，以及为什么这样设计。

## 入口

`scripts/` 下的三个脚本就是全部接口。可以在任何目录运行，它们会自己定位中央仓库。

| 入口 | 职责 |
| --- | --- |
| `scripts/agent-skills.sh` | 只读与纯本机命令：`list`、`show`、`sync`、`doctor`、`check`、`diff`、`project`。它会拒绝所有写入已提交状态的子命令，并指出对应的启动器。 |
| `scripts/install-skill.sh` | 安装。校验请求，把 tracked 变更 commit 到 `main`，然后 reconcile symlink。 |
| `scripts/change-skill.sh` | 其余所有变更：`--action remove`、`delete`、`update`、`enable`、`disable`。与安装器同样的发布纪律。 |

查看与 reconcile：

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

安装。`--skill`、`--source-url`、`--scope` 必填；`--scope global` 时 `--agents` 必填，`--scope project` 时默认为 `"*"`：

```bash
# 全局装给某一个 Agent
skills/manage-agent-skills/scripts/install-skill.sh \
  --skill herdr \
  --source-url https://github.com/owner/herdr \
  --scope global --agents claude

# 装给当前项目的所有 Agent —— 在项目 checkout 目录里运行；
# 省略 --project 时会从 git remote 推导
skills/manage-agent-skills/scripts/install-skill.sh \
  --skill review \
  --source-url https://github.com/owner/skills/tree/main/skills/review \
  --scope project
```

尚未注册的 Skill 还可以带 `--repo`、`--source-id`、`--path`，以及可选的 `--ref`，用于导入并锁定来源。

状态变更。`--action` 的取值就是 manager 自己的命令名：

```bash
# 从某个 scope 解除链接
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill review --scope project
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill herdr --scope global --agents claude
skills/manage-agent-skills/scripts/change-skill.sh --action remove --skill herdr --all

# 删除一个 Skill，或整个第三方 source（--skill / --source 必须恰好一个）
skills/manage-agent-skills/scripts/change-skill.sh --action delete --skill review
skills/manage-agent-skills/scripts/change-skill.sh --action delete --source owner-skills

# 用 check/diff 确认之后升级锁定的 source
skills/manage-agent-skills/scripts/change-skill.sh --action update --source anthropic

# 临时停用一个 Skill（不删除任何 target），以及重新启用
skills/manage-agent-skills/scripts/change-skill.sh --action disable --skill review
skills/manage-agent-skills/scripts/change-skill.sh --action enable --skill review
```

两个启动器都接受 `--no-push`，只保留本地 commit。

## 护栏为什么存在

`install`、`remove`、`delete`、`update`、`enable`、`disable` 会改写 git 跟踪的 `registry/skills.yaml` 和 `.skill-manager/lock.yaml`。如果裸跑这些子命令，文件变了却没有 commit，中央仓库就会变脏，之后每次启动器运行都会因 "central agent-skills repository has uncommitted changes" 失败——工具把自己卡死。所以 `agent-skills.sh` 直接拒绝这些子命令，并指向会把变更一并 commit 到 `main` 的启动器。

## 发布模型

中央仓库存放的是你自己的配置，而不是等待 review 的共享代码，所以 `main` 是唯一代表它的分支：启动器直接 commit 到 `main`，从不开分支、不建 pull request。

每次运行都按同一个顺序应用变更——先改 registry、lock 和 vendor，然后校验，然后 commit，最后才 reconcile symlink。在 commit 之前失败时，机器上的链接一根都没动过，仓库也会恢复到干净的 `main`，因此失败的运行不需要任何 Git 手术。校验按改动范围分级：只改 registry 时只需证明 registry 仍能解析，而改动 manager 自身源码时会跑完整的 check 和 build。commit 之后启动器会推送 `main`，除非传了 `--no-push`；推送被拒只报警告而非失败，因为本地 commit 与链接已经一致。

## 全局与项目级 scope

- **全局**安装记录在已提交的 registry 里，跟随你到每一台设备：`git pull` 加 `agent-skills.sh sync` 就能在任何机器上重建。
- **项目级**安装是本机状态。它记在被 gitignore 的 `.skill-manager/projects.local.yaml` 里，不产生 commit，也不跨设备——新设备需要在那台机器上重新执行一次项目安装。这是有意为之的取舍：不同设备上的项目、以及它们的路径本来就不一样，同步它们只会给每台其他机器留下一条无法执行的记录。
- 无论哪种 scope，Skill 的内容、来源和锁定的 commit 始终会提交。本机化的只是「这台机器的哪个目录也装一份」，所以 review 与 lock 的保证不受影响。
- 在项目内，Codex、Kimi Code、Pi、OpenCode 共用 `.agents/skills`，只有 Claude Code 有独立的 `.claude/skills`。因此「只装给这四个中的某一个」在物理上做不到——共用目录的每个 Agent 都会看到这个 Skill——安装计划会把这些顺带看到的 Agent 如实报告为 `impliedAgents`。

## 在新设备上开始

clone 仓库之后直接跑任一入口即可，没有额外的安装步骤。脚本会在首次运行时自动安装缺失的 npm 依赖并初始化 vendor submodule，然后直接运行 TypeScript 源码——不需要构建。这件事无法交给 Git hook：hook 存放在 `.git/hooks`，而它不参与克隆，所以 hook 恰恰帮不了最需要帮助的那个场景——新机器上的全新 clone。

## scripts/ 各文件职责

| 文件 | 职责 |
| --- | --- |
| `agent-skills.sh` | 只读/本机入口；先拒绝变更类子命令（代价为零），再为全新 clone 做引导，其余请求转发给 CLI。 |
| `install-skill.sh` | 安装启动器的 shell 包装；在进入中央仓库前记录你的工作目录。 |
| `install-skill.mjs` | 校验安装参数，准备中央仓库，并把安装交给 manager 的 publish 路径。 |
| `change-skill.sh` | 变更启动器的 shell 包装，对应 `remove` / `delete` / `update` / `enable` / `disable`。 |
| `change-skill.mjs` | 按 action 校验变更参数，并映射为 manager 的操作数与 commit 标题。 |
| `bootstrap.mjs` | 共享的前置检查：拒绝脏工作树、fast-forward 到 `origin/main`、安装依赖、初始化 submodule，并在拉取改动了启动器自身时重新执行它。 |
| `install-helpers.mjs` | 共享辅助：进程执行、参数解析、从 Git remote 推导逻辑 project ID。 |
| `change-helpers.mjs` | 变更启动器按 action 的参数校验与操作数/commit 标题映射。 |
| `run-with-node.sh` | 查找 Node.js 20+ 运行时——`AGENT_SKILLS_NODE`、`PATH`、nvm、Volta——并用它执行真正的入口。 |
