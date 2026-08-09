import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveGitIdentity } from "../skills/manage-agent-skills/scripts/git-identity.mjs";
import { parseArgs, projectIdFromRemote, run } from "../skills/manage-agent-skills/scripts/install-helpers.mjs";

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
    expect(skill).toContain("The installation CLI uses internal adapter IDs");
    expect(skill).toContain("changes to the central `agent-skills` repository, and selects an installed Node.js 20+ runtime there");
    expect(skill).toContain("| Claude Code | `claude` |");
    expect(skill).toContain("New Skill in an existing source: pass `--source-id` and `--path`; omit `--repo` and `--ref`");
    expect(skill).toContain("Do not assume `agent-skills` is installed on `PATH`");
    expect(skill).not.toContain("committed on a branch, pushed, and opened as a Draft PR");
    expect(openAiMetadata).toContain("allow_implicit_invocation: false");
  });
});
