import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveGitIdentity } from "../skills/manage-agent-skills/scripts/git-identity.mjs";

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

  it("uses the requested commit title and opens a Draft PR", async () => {
    const script = await fs.readFile(path.resolve("skills/manage-agent-skills/scripts/install-skill.mjs"), "utf8");
    expect(script).toContain('resolveGitIdentity(root)');
    expect(script).toContain('`feat(skills): 添加 ${values.get("--skill")} skill (${values.get("--source-url")})`');
    expect(script).toContain('["pr", "create", "--draft", "--base", "main"');
  });

  it("changes to the central repository before launching Node and preserves the working directory", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "manage-agent-skills-launcher-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const workdir = path.join(temporaryRoot, "business-project");
    const output = path.join(temporaryRoot, "node-output.txt");
    await fs.mkdir(fakeBin);
    await fs.mkdir(workdir);
    await fs.writeFile(path.join(fakeBin, "node"), `#!/bin/sh\nprintf '%s\\n' "$PWD" > "$LAUNCH_OUTPUT"\nprintf '%s\\n' "$@" >> "$LAUNCH_OUTPUT"\n`);
    await fs.chmod(path.join(fakeBin, "node"), 0o755);
    try {
      await execFileAsync(path.resolve("skills/manage-agent-skills/scripts/install-skill.sh"), ["--skill", "foo"], {
        cwd: workdir,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, LAUNCH_OUTPUT: output },
      });
      const lines = (await fs.readFile(output, "utf8")).trim().split("\n");
      expect(lines[0]).toBe(path.resolve("."));
      expect(lines).toEqual(expect.arrayContaining(["--workdir", await fs.realpath(workdir), "--skill", "foo"]));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("treats scope examples as intent guidance and documents internal adapter IDs", async () => {
    const skill = await fs.readFile(path.resolve("skills/manage-agent-skills/SKILL.md"), "utf8");
    expect(skill).toContain("Infer scope from the user’s complete intent; do not keyword-match fixed phrases");
    expect(skill).toContain("The installation CLI uses internal adapter IDs");
    expect(skill).toContain("changes to the central `agent-skills` repository, and only then starts Node");
    expect(skill).toContain("| Claude Code | `claude` |");
    expect(skill).not.toContain("committed on a branch, pushed, and opened as a Draft PR");
  });
});
