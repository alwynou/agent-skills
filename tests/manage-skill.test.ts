import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { changeMetadata, changeOperands, parseChangeArgs } from "../skills/manage-agent-skills/scripts/change-helpers.mjs";
import { installOperands, parseArgs, projectIdFromRemote, run } from "../skills/manage-agent-skills/scripts/install-helpers.mjs";
import { publishArgs } from "../skills/manage-agent-skills/scripts/bootstrap.mjs";

const execFileAsync = promisify(execFile);

describe("manage-agent-skills", () => {
  it("hands the install flags to the manager unchanged", () => {
    const scoped = parseArgs([
      "--skill", "review", "--source-url", "https://example.com/review", "--scope", "project", "--agents", "claude",
    ]);
    expect(installOperands(scoped, "/work/app")).toEqual([
      "install", "review", "--scope", "project", "--agents", "claude", "--project", "app", "--project-path", "/work/app",
    ]);

    const everyAgent = parseArgs(["--skill", "review", "--source-url", "https://example.com/review", "--scope", "global", "--agents", "*"]);
    expect(installOperands(everyAgent, "/work/app")).toEqual(["install", "review", "--scope", "global", "--agents", "*"]);

    expect(() => parseArgs(["--skill", "review", "--source-url", "https://example.com/review", "--scope", "agent-global"]))
      .toThrow("--scope must be global or project");
    expect(() => parseArgs(["--skill", "review", "--source-url", "https://example.com/review", "--scope", "global"]))
      .toThrow("--agents is required for global scope");
  });

  it("wraps operands in a titled publish invocation", () => {
    expect(publishArgs("feat(skills): 添加 review skill (https://example.com/review)", ["install", "review"], false))
      .toEqual(["src/cli.ts", "publish", "--title", "feat(skills): 添加 review skill (https://example.com/review)", "--", "install", "review"]);
    expect(publishArgs("chore(skills): 删除 review skill", ["delete", "review"], true))
      .toEqual(["src/cli.ts", "publish", "--title", "chore(skills): 删除 review skill", "--no-push", "--", "delete", "review"]);
  });

  it("rearranges change flags into manager operands and commit titles", () => {
    const projectRemove = parseChangeArgs([
      "--action", "remove", "--skill", "review", "--scope", "project", "--project", "storefront",
    ]);
    expect(changeOperands(projectRemove)).toEqual(["remove", "review", "--scope", "project", "--project", "storefront"]);
    expect(changeMetadata(projectRemove)).toEqual({ title: "chore(skills): 移除 review 的 project 安装" });

    const agentRemove = parseChangeArgs(["--action", "remove", "--skill", "review", "--scope", "global", "--agents", "claude"]);
    expect(changeOperands(agentRemove)).toEqual(["remove", "review", "--scope", "global", "--agents", "claude"]);

    const everyTarget = parseChangeArgs(["--action", "remove", "--skill", "review", "--all"]);
    expect(changeOperands(everyTarget)).toEqual(["remove", "review", "--all"]);
    expect(changeMetadata(everyTarget)).toEqual({ title: "chore(skills): 移除 review 的 全部 安装" });

    const sourceDelete = parseChangeArgs(["--action", "delete", "--source", "upstream"]);
    expect(changeOperands(sourceDelete)).toEqual(["delete", "--source", "upstream"]);
    expect(changeMetadata(sourceDelete)).toEqual({ title: "chore(skills): 删除 upstream source 及其 Skills" });

    expect(() => parseChangeArgs(["--action", "remove", "--skill", "review", "--scope", "global"]))
      .toThrow("--agents is required for global removal");
    expect(() => parseChangeArgs(["--action", "delete", "--skill", "review", "--source", "upstream"]))
      .toThrow("exactly one of --skill or --source");
    expect(() => parseChangeArgs(["--action", "delete-source", "--source", "upstream"]))
      .toThrow("--action must be remove, delete, update, enable, disable");
  });

  it("keeps the launchers free of branch and pull-request machinery", async () => {
    for (const name of ["install-skill.mjs", "change-skill.mjs", "bootstrap.mjs"]) {
      const script = await fs.readFile(path.resolve("skills/manage-agent-skills/scripts", name), "utf8");
      expect(script, name).not.toContain('"switch", "-c"');
      expect(script, name).not.toContain('"pr", "create"');
    }
  });

  it("changes to the central repository before launching Node and preserves the working directory", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manage-agent-skills-launcher-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const fakeNvm = path.join(temporaryRoot, "nvm");
    const compatibleBin = path.join(fakeNvm, "versions", "node", "v22.1.0", "bin");
    const workdir = path.join(temporaryRoot, "business-project");
    const output = path.join(temporaryRoot, "node-output.txt");
    await fs.mkdir(fakeBin);
    await fs.mkdir(compatibleBin, { recursive: true });
    await fs.mkdir(workdir);
    await fs.writeFile(path.join(fakeBin, "node"), "#!/bin/sh\n[ \"${1:-}\" = -p ] && { echo 14; exit 0; }\nexit 99\n");
    await fs.chmod(path.join(fakeBin, "node"), 0o755);
    const compatibleNode = path.join(compatibleBin, "node");
    await fs.writeFile(compatibleNode, `#!/bin/sh\nif [ "\${1:-}" = -p ]; then echo 22; exit 0; fi\nprintf '%s\\n' "$PWD" > "$LAUNCH_OUTPUT"\nprintf '%s\\n' "$@" >> "$LAUNCH_OUTPUT"\n`);
    await fs.chmod(compatibleNode, 0o755);
    try {
      await execFileAsync(path.resolve("skills/manage-agent-skills/scripts/install-skill.sh"), ["--skill", "foo"], {
        cwd: workdir,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, NVM_DIR: fakeNvm, LAUNCH_OUTPUT: output },
      });
      const lines = (await fs.readFile(output, "utf8")).trim().split("\n");
      expect(lines[0]).toBe(path.resolve("."));
      expect(lines).toEqual(expect.arrayContaining(["--workdir", await fs.realpath(workdir), "--skill", "foo"]));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("includes captured stderr in command failures", () => {
    expect(() => run(process.execPath, ["-e", "process.stderr.write('specific failure'); process.exit(7)"], process.cwd(), { capture: true }))
      .toThrow("specific failure");
  });

  it("rejects unknown, duplicate, and valueless launcher arguments", () => {
    const required = ["--skill", "foo", "--source-url", "https://example.com/foo", "--scope", "global", "--agents", "*"];
    expect(() => parseArgs([...required, "--unknown", "value"])).toThrow("unknown argument --unknown");
    expect(() => parseArgs([...required, "--skill", "bar"])).toThrow("duplicate argument --skill");
    expect(() => parseArgs([...required, "--path"])).toThrow("--path requires a value");
    // A project install may name one agent, exactly as a global install does.
    expect(parseArgs(["--skill", "foo", "--source-url", "https://example.com/foo", "--scope", "project", "--agents", "codex"]).get("--agents"))
      .toBe("codex");
  });

  it("derives project IDs from GitHub and other hosted Git remotes", () => {
    expect(projectIdFromRemote("https://github.com/acme/storefront.git")).toBe("acme-storefront");
    expect(projectIdFromRemote("git@github.com:acme/storefront.git")).toBe("acme-storefront");
    expect(projectIdFromRemote("https://codeup.aliyun.com/cdfinance/cfpamf_front/storehouse-manage-front.git"))
      .toBe("cfpamf-front-storehouse-manage-front");
    expect(projectIdFromRemote("/tmp/storefront.git")).toBeNull();
  });

  it("treats scope examples as intent guidance and documents internal adapter IDs", async () => {
    const skill = await fs.readFile(path.resolve("skills/manage-agent-skills/SKILL.md"), "utf8");
    const openAiMetadata = await fs.readFile(path.resolve("skills/manage-agent-skills/agents/openai.yaml"), "utf8");
    expect(skill).toContain("Infer scope from the user’s complete intent; do not keyword-match fixed phrases");
    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain("`--agents` takes an internal adapter ID, or `\"*\"` for every supported Agent");
    expect(skill).toContain("changes to the central `agent-skills` repository, and selects an installed Node.js 20+ runtime there");
    expect(skill).toContain("| Claude Code | `claude` |");
    expect(skill).toContain("New Skill in an existing source: pass `--source-id` and `--path`; omit `--repo` and `--ref`");
    expect(skill).toContain("Do not assume `agent-skills` is installed on `PATH`");
    expect(skill).toContain("Project scope creates `.agents/skills/<name>` plus `.claude/skills/<name>` compatibility links");
    expect(skill).toContain("Treat “remove”, “uninstall”, or equivalent wording as unlinking only");
    expect(skill).toContain("Deleting the only Skill from a third-party source removes the source too");
    expect(skill).toContain("Both launchers commit straight to `main`; they never create a branch or a pull request");
    expect(skill).toContain("only then reconciles the symlinks");
    expect(skill).toContain("Every form accepts `--no-push` to keep the commit local");
    expect(skill).toContain("scripts/agent-skills.sh show <skill> [--json]");
    expect(skill).toContain("whether the project is bound on this machine for a project target");
    expect(skill).toContain("run `<skill-real-path>/scripts/agent-skills.sh doctor` first");
    expect(skill).toContain("run `<skill-real-path>/scripts/agent-skills.sh sync` after every `git pull`");
    expect(skill).toContain("`.skill-manager/projects.local.yaml`, which is git-ignored");
    expect(skill).toContain("“project X is not bound on this device”");
    expect(skill).toContain("agent-skills.sh project bind <project-id> <path>");
    expect(skill).toContain("agent-skills.sh project unbind <project-id>");
    expect(skill).toContain("agent-skills.sh check [source]` to see how many commits a source lags behind");
    expect(skill).toContain("Both are read-only and never touch the vendor trees or the lock file");
    expect(skill).toContain("change-skill.sh --action update --source <source-id>");
    expect(skill).toContain("--scope <global|project>");
    expect(skill).toContain("[--agents <agent-id|\"*\">]");
    expect(skill).toContain("`--agents` is required with `--scope global`");
    expect(skill).toContain("change-skill.sh --action remove --skill <skill-name> --all");
    expect(skill).toContain("you must choose exactly one shape: `--all`, `--scope global --agents <id|\"*\">`, or `--scope project [--project <id>]`");
    expect(skill).toContain("For `delete`, pass exactly one of `--skill` or `--source`");
    expect(skill).toContain("change-skill.sh --action delete --source <source-id>");
    expect(skill).toContain("| Executing Agent | `--agents` value |");
    expect(skill).not.toContain("agent-global");
    expect(skill).not.toContain("all-global");
    expect(skill).not.toContain("delete-source");
    expect(skill).not.toContain("update-source");
    expect(skill).not.toContain("`--agent`");
    expect(skill).toContain("change-skill.sh --action disable --skill <skill-name>");
    expect(skill).toContain("Disabling removes the symlinks; enabling rebuilds them");
    expect(skill).toContain("refuses the mutating subcommands `install`, `remove`, `delete`, `update`, `enable`, and `disable`");
    expect(skill).toContain("(`list`, `show`, `sync`, `doctor`, `check`, `diff`, `project`)");
    expect(skill).toContain("Codex, Kimi Code, Pi, and OpenCode share `.agents/skills`");
    expect(skill).toContain("only Claude Code owns a separate `.claude/skills`");
    expect(skill).toContain("reports those extra viewers in `impliedAgents`; relay them to the user verbatim");
    expect(skill).toContain("--scope project [--project <logical-project-id>]");
    expect(skill).toContain("derives the logical project ID from the current working directory’s Git remote");
    expect(skill).not.toContain("Draft PR");
    expect(openAiMetadata).toContain("allow_implicit_invocation: false");
  });
});
