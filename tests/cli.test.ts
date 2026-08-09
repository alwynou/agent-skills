import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("CLI", () => {
  it("lists global and project targets separately", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-cli-test-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "registry"), { recursive: true });
    await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "example"), { recursive: true });
    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await execFileAsync("git", ["-C", path.join(root, "app"), "init", "--quiet"]);
    await fs.writeFile(path.join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: test\n---\n");
    await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), "sources: {}\n");
    await fs.writeFile(
      path.join(root, "registry", "skills.yaml"),
      [
        "sources: {}",
        "projects:",
        "  - app",
        "skills:",
        "  example:",
        "    source: local",
        "    path: skills/example",
        "    enabled: true",
        "    targets:",
        "      - scope: global",
        "        agents: [codex]",
        "      - scope: project",
        "        project: app",
        "        agents: [\"*\"]",
        "",
      ].join("\n"),
    );

    const executable = path.resolve("node_modules", ".bin", "tsx");
    const { stdout } = await execFileAsync(executable, ["src/cli.ts", "--root", root, "list"], {
      cwd: path.resolve("."),
    });
    expect(stdout).toContain("'global'");
    expect(stdout).toContain("'project'");
    expect(stdout).toContain("'app'");

    const dryRun = await execFileAsync(executable, [
      "src/cli.ts", "--root", root, "install", "example", "--scope", "global", "--agents", "opencode", "--dry-run", "--json",
    ], { cwd: path.resolve(".") });
    const installPlan = JSON.parse(dryRun.stdout);
    expect(installPlan.applied).toBe(false);
    expect(installPlan.target).toEqual({ scope: "global", agents: ["opencode"] });
    expect(installPlan.links).toEqual([path.join(os.homedir(), ".config", "opencode", "skills", "example")]);
    expect((await fs.readFile(path.join(root, "registry", "skills.yaml"), "utf8"))).not.toContain("opencode");

    const projectDryRun = await execFileAsync(executable, [
      "src/cli.ts", "--root", root, "install", "example", "--scope", "project",
      "--project", "app", "--project-path", path.join(root, "app"), "--dry-run", "--json",
    ], { cwd: path.resolve(".") });
    const projectPlan = JSON.parse(projectDryRun.stdout);
    expect(projectPlan.target).toEqual({ scope: "project", project: "app", agents: ["*"] });
    expect(projectPlan.links.sort()).toEqual([
      path.join(root, "app", ".agents", "skills", "example"),
      path.join(root, "app", ".claude", "skills", "example"),
    ].sort());

    const environment = { ...process.env, AGENT_SKILLS_HOME: path.join(root, "home") };
    const beforeBind = await execFileAsync(executable, ["src/cli.ts", "--root", root, "project", "list"], {
      cwd: path.resolve("."),
      env: environment,
    });
    expect(beforeBind.stdout).toContain("'unbound'");
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "project", "bind", "app", path.join(root, "app")], {
      cwd: path.resolve("."),
      env: environment,
    });
    expect(await fs.readFile(path.join(root, ".skill-manager", "projects.local.yaml"), "utf8")).toContain(path.join(root, "app"));
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "sync"], {
      cwd: path.resolve("."),
      env: environment,
    });
    const doctor = await execFileAsync(executable, ["src/cli.ts", "--root", root, "doctor"], {
      cwd: path.resolve("."),
      env: environment,
    });
    expect(doctor.stdout).toContain("codex+kimi-code+pi-agent+opencode/app/example: link is correct");
    expect(doctor.stdout).toContain("claude/app/example: link is correct");
    expect(doctor.stdout).not.toContain("✗");
    expect(await fs.readFile(path.join(root, "app", ".git", "info", "exclude"), "utf8")).toContain(
      "/.agents/skills/example",
    );
    expect(await fs.readFile(path.join(root, "app", ".git", "info", "exclude"), "utf8")).toContain(
      "/.claude/skills/example",
    );

    await expect(execFileAsync(executable, ["src/cli.ts", "--root", root, "project", "unbind", "app"], {
      cwd: path.resolve("."),
      env: environment,
    })).rejects.toMatchObject({ stderr: expect.stringContaining("still has managed links") });
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "disable", "example"], { cwd: path.resolve("."), env: environment });
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "sync"], { cwd: path.resolve("."), env: environment });
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "project", "unbind", "app"], { cwd: path.resolve("."), env: environment });
    expect(await fs.readFile(path.join(root, ".skill-manager", "projects.local.yaml"), "utf8")).not.toContain(path.join(root, "app"));
  });
});
