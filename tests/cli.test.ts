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
    await fs.writeFile(path.join(root, ".skill-manager", "managed-links.json"), '{"version":1,"links":[]}\n');
    await fs.writeFile(
      path.join(root, "registry", "skills.yaml"),
      [
        "sources: {}",
        "projects:",
        "  app:",
        "    path: app",
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
        "        agents: [claude]",
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

    const environment = { ...process.env, AGENT_SKILLS_HOME: path.join(root, "home") };
    await execFileAsync(executable, ["src/cli.ts", "--root", root, "sync"], {
      cwd: path.resolve("."),
      env: environment,
    });
    const doctor = await execFileAsync(executable, ["src/cli.ts", "--root", root, "doctor"], {
      cwd: path.resolve("."),
      env: environment,
    });
    expect(doctor.stdout).toContain("claude/app/example: link is correct");
    expect(doctor.stdout).not.toContain("✗");
    expect(await fs.readFile(path.join(root, "app", ".git", "info", "exclude"), "utf8")).toContain(
      "/.claude/skills/example",
    );
  });
});
