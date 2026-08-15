import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = path.resolve("skills", "manage-agent-skills", "scripts", "agent-skills.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(script, args, { cwd: path.resolve("."), env: { ...process.env, ...env } });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function makeRegistryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-guard-test-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", "example"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: test\n---\n");
  await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), "sources: {}\n");
  await fs.writeFile(
    path.join(root, "registry", "skills.yaml"),
    [
      "sources: {}",
      "skills:",
      "  example:",
      "    source: local",
      "    path: skills/example",
      "    enabled: true",
      "    targets:",
      "      - scope: global",
      "        agents: [codex]",
      "",
    ].join("\n"),
  );
  return root;
}

describe("agent-skills.sh guard", () => {
  it("rejects mutating subcommands with a non-zero exit code", async () => {
    for (const command of ["install", "remove", "delete", "update", "enable", "disable"]) {
      const result = await run([command, "example"]);
      expect(result.code, command).not.toBe(0);
      expect(result.stderr, command).toContain("error:");
      expect(result.stderr, command).toContain("git-tracked registry and lock files");
    }
  });

  it("points install to install-skill.sh", async () => {
    const result = await run(["install", "example", "--scope", "global", "--agents", "codex"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("install-skill.sh");
    expect(result.stderr).not.toContain("change-skill.sh");
  });

  it("points remove and delete to change-skill.sh", async () => {
    for (const command of ["remove", "delete"]) {
      const result = await run([command, "example"]);
      expect(result.code, command).not.toBe(0);
      expect(result.stderr, command).toContain("change-skill.sh");
    }
  });

  it("requires update, enable and disable to go through change-skill.sh", async () => {
    for (const command of ["update", "enable", "disable"]) {
      const result = await run([command, "example"]);
      expect(result.code, command).not.toBe(0);
      expect(result.stderr, command).toContain("change-skill.sh");
    }
  });

  it("skips a leading --root <path> option before matching the subcommand", async () => {
    const result = await run(["--root", "/tmp/whatever", "install", "example"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("install-skill.sh");
  });

  it("lets help invocations through", async () => {
    for (const args of [[], ["--help"], ["-h"], ["help"]]) {
      const result = await run(args);
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stdout, args.join(" ")).toContain("agent-skills");
    }
  });

  it("lets read-only subcommands through to the CLI", async () => {
    const root = await makeRegistryRoot();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-guard-home-"));
    temporaryDirectories.push(home);
    const env = { AGENT_SKILLS_HOME: home };

    const list = await run(["--root", root, "list"], env);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain("example");

    const projects = await run(["--root", root, "project", "list"], env);
    expect(projects.code, projects.stderr).toBe(0);
    expect(projects.stdout).toContain("No projects registered.");

    // doctor may report diagnostics against the throwaway root; what matters is
    // that the guard lets it through to the CLI instead of refusing it.
    const doctor = await run(["--root", root, "doctor"], env);
    expect(doctor.stderr).not.toContain("error: doctor");
    expect(doctor.stdout + doctor.stderr).not.toBe("");

    const show = await run(["--root", root, "show", "example"], env);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain("example");

    const sync = await run(["--root", root, "sync"], env);
    expect(sync.code, sync.stderr).toBe(0);
  });
});
