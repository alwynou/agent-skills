import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveGitIdentity } from "../skills/manage-agent-skills/scripts/git-identity.mjs";
import { changeCliArgs, changeMetadata, parseChangeArgs } from "../skills/manage-agent-skills/scripts/change-helpers.mjs";
import { parseArgs, projectIdFromRemote, run } from "../skills/manage-agent-skills/scripts/install-helpers.mjs";
import { touchesRuntime } from "../skills/manage-agent-skills/scripts/publish.mjs";

const execFileAsync = promisify(execFile);

describe("manage-agent-skills", () => {
  it("uses central repository local identity with per-field global fallback", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manage-agent-skills-identity-"));
    const repository = path.join(temporaryRoot, "manager");
    const home = path.join(temporaryRoot, "home");
    await fs.mkdir(repository);
    await fs.mkdir(home);
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
    try {
      await execFileAsync("git", ["init", "--quiet", repository], { env });
      await execFileAsync("git", ["-C", repository, "config", "--local", "user.name", "Repository User"], { env });
      await execFileAsync("git", ["config", "--global", "user.name", "Global User"], { env });
      await execFileAsync("git", ["config", "--global", "user.email", "global@example.com"], { env });
      expect(resolveGitIdentity(repository, env)).toEqual({ name: "Repository User", email: "global@example.com" });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("uses the requested commit title and never branches or opens a pull request", async () => {
    const script = await fs.readFile(path.resolve("skills/manage-agent-skills/scripts/install-skill.mjs"), "utf8");
    expect(script).toContain('`feat(skills): 添加 ${values.get("--skill")} skill (${values.get("--source-url")})`');
    expect(script).toContain('run("git", ["switch", "main"], root)');
    expect(script).not.toContain('"switch", "-c"');
    expect(script).not.toContain('"pr", "create"');
  });

  it("maps remove and delete requests to deterministic CLI and publication metadata", () => {
    const projectRemove = parseChangeArgs([
      "--action", "remove", "--skill", "review", "--scope", "project", "--project", "storefront",
    ]);
    expect(changeCliArgs(projectRemove, { dryRun: true })).toEqual([
      "src/cli.ts", "remove", "review", "--scope", "project", "--project", "storefront", "--dry-run", "--no-sync", "--json",
    ]);
    expect(changeCliArgs(projectRemove, { sync: false })).toEqual([
      "src/cli.ts", "remove", "review", "--scope", "project", "--project", "storefront", "--no-sync", "--json",
    ]);
    expect(changeMetadata(projectRemove)).toEqual({ title: "chore(skills): 移除 review 的 project 安装" });

    const sourceDelete = parseChangeArgs(["--action", "delete-source", "--source", "upstream"]);
    expect(changeCliArgs(sourceDelete)).toEqual(["src/cli.ts", "delete", "--source", "upstream", "--json"]);
    expect(changeMetadata(sourceDelete)).toEqual({ title: "chore(skills): 删除 upstream source 及其 Skills" });
    expect(() => parseChangeArgs(["--action", "remove", "--skill", "review", "--scope", "agent-global"]))
      .toThrow("--agent is required");
    expect(() => parseChangeArgs(["--action", "delete-source", "--source", "upstream", "--skill", "review"]))
      .toThrow("--skill is not allowed");
  });

  it("commits removals and deletions straight onto main", async () => {
    const script = await fs.readFile(path.resolve("skills/manage-agent-skills/scripts/change-skill.mjs"), "utf8");
    expect(script).toContain("commitOnMain(");
    expect(script).toContain("plan.noOp ? plan");
    expect(script).not.toContain('"switch", "-c"');
    expect(script).not.toContain('"pr", "create"');
  });

  it("commits before reconciling links and restores main when publication fails", async () => {
    const script = await fs.readFile(path.resolve("skills/manage-agent-skills/scripts/publish.mjs"), "utf8");
    expect(script).toContain("resolveGitIdentity(root)");
    expect(script).toContain('"add", "-A", "--", target');
    expect(script).toContain('details.includes("did not match any files")');
    expect(script.indexOf("commit\", \"-m\", title")).toBeLessThan(script.indexOf("run(tsx, syncArgs"));
    expect(script).toContain('"restore", "--source", revision, "--staged", "--worktree", "--", target');
  });

  it("scopes validation to the paths a change actually touches", () => {
    expect(touchesRuntime(["registry/skills.yaml", ".skill-manager/lock.yaml", "vendors/upstream", ".gitmodules"])).toBe(false);
    expect(touchesRuntime(["registry/skills.yaml", "src/core/manager.ts"])).toBe(true);
    expect(touchesRuntime(["skills/manage-agent-skills/SKILL.md"])).toBe(true);
    expect(touchesRuntime(["package-lock.json"])).toBe(true);
  });

  it("accepts --no-push as a flag in both launchers", () => {
    const required = ["--skill", "foo", "--source-url", "https://example.com/foo", "--scope", "all-global"];
    expect(parseArgs([...required, "--no-push"]).has("--no-push")).toBe(true);
    expect(parseChangeArgs(["--action", "delete", "--skill", "review", "--no-push"]).has("--no-push")).toBe(true);
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
    const required = ["--skill", "foo", "--source-url", "https://example.com/foo", "--scope", "all-global"];
    expect(() => parseArgs([...required, "--unknown", "value"])).toThrow("unknown argument --unknown");
    expect(() => parseArgs([...required, "--skill", "bar"])).toThrow("duplicate argument --skill");
    expect(() => parseArgs([...required, "--path"])).toThrow("--path requires a value");
    // A project install may name one agent; only the all-global scope forbids it.
    expect(parseArgs(["--skill", "foo", "--source-url", "https://example.com/foo", "--scope", "project", "--agent", "codex"]).get("--agent"))
      .toBe("codex");
    expect(() => parseArgs([...required, "--agent", "codex"]))
      .toThrow("--agent is only allowed for agent-global or project scope");
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
    expect(skill).toContain("Global installation for one Agent uses internal adapter IDs");
    expect(skill).toContain("changes to the central `agent-skills` repository, and selects an installed Node.js 20+ runtime there");
    expect(skill).toContain("| Claude Code | `claude` |");
    expect(skill).toContain("New Skill in an existing source: pass `--source-id` and `--path`; omit `--repo` and `--ref`");
    expect(skill).toContain("Do not assume `agent-skills` is installed on `PATH`");
    expect(skill).toContain("Project scope creates `.agents/skills/<name>` plus `.claude/skills/<name>` compatibility links");
    expect(skill).toContain("Treat “remove”, “uninstall”, or equivalent wording as unlinking only");
    expect(skill).toContain("Deleting the only Skill from a third-party source removes the source too");
    expect(skill).toContain("change-skill.sh --action delete-source");
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
    expect(skill).toContain("change-skill.sh --action update-source --source <source-id>");
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
