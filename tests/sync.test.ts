import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFs } from "../src/core/fs.js";
import { projectPaths } from "../src/core/paths.js";
import { RegistryStore } from "../src/registry/store.js";
import { Synchronizer } from "../src/installer/synchronizer.js";
import { builtInAdapters } from "../src/agents/adapter.js";
import type { ResolvedSkill, ResolvedSkillTarget } from "../src/core/types.js";
import { GitClient } from "../src/git/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-test-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const skillPath = path.join(root, "skills", "example");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(skillPath, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), "---\nname: example\ndescription: test\n---\n");
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  const fsPort = new NodeFs();
  const git = new GitClient();
  const store = new RegistryStore(fsPort, projectPaths(root));
  const synchronizer = new Synchronizer(fsPort, store, builtInAdapters(home), git);
  const globalTarget: ResolvedSkillTarget = {
    scope: "global",
    agents: ["codex", "claude", "kimi-code", "pi-agent", "opencode"],
  };
  const projectTarget: ResolvedSkillTarget = {
    scope: "project",
    projectId: "app",
    projectRoot,
    agents: ["codex", "claude", "kimi-code", "pi-agent", "opencode"],
  };
  const skill = (targets: ResolvedSkillTarget[]): ResolvedSkill => ({
    name: "example",
    sourceId: "local",
    absolutePath: skillPath,
    enabled: true,
    targets,
  });
  return { root, home, projectRoot, globalTarget, projectTarget, skill, store, synchronizer, git };
}

describe("synchronizer", () => {
  it("creates idempotent global links", async () => {
    const { root, home, globalTarget, skill, synchronizer } = await fixture();
    const resolved = skill([globalTarget]);
    const first = await synchronizer.sync([resolved]);
    expect(first.created).toHaveLength(5);
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".skill-manager", "managed-links.json"), "utf8"));
    expect(manifest.version).toBe(2);
    expect(manifest.links.every((link: { scope: string }) => link.scope === "global")).toBe(true);

    const second = await synchronizer.sync([resolved]);
    expect(second.created).toHaveLength(0);
    expect(second.unchanged).toHaveLength(5);
    expect(await fs.realpath(path.join(home, ".agents", "skills", "example"))).toBe(
      await fs.realpath(resolved.absolutePath),
    );
  });

  it("rejects obsolete managed-link manifests", async () => {
    const { root, globalTarget, skill, synchronizer } = await fixture();
    await fs.writeFile(path.join(root, ".skill-manager", "managed-links.json"), '{"version":1,"links":[]}\n');
    await expect(synchronizer.sync([skill([globalTarget])])).rejects.toThrow("unsupported managed-links file");
  });

  it("creates project links in every agent-specific directory and maintains Git exclude", async () => {
    const { projectRoot, projectTarget, skill, synchronizer, git } = await fixture();
    await git.run(projectRoot, ["init", "--quiet"]);
    await fs.appendFile(path.join(projectRoot, ".git", "info", "exclude"), "custom-user-rule\n");
    const resolved = skill([projectTarget]);
    const result = await synchronizer.sync([resolved]);
    expect(result.created).toHaveLength(5);

    for (const relativePath of [
      ".agents/skills/example",
      ".claude/skills/example",
      ".kimi-code/skills/example",
      ".pi/skills/example",
      ".opencode/skills/example",
    ]) {
      expect(await fs.realpath(path.join(projectRoot, relativePath))).toBe(await fs.realpath(resolved.absolutePath));
    }
    const exclude = await fs.readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# BEGIN agent-skills-manager project links");
    expect(exclude).toContain("/.agents/skills/example");
    expect(exclude).toContain("/.opencode/skills/example");
    expect(exclude).toContain("custom-user-rule");
  });

  it("allows the same skill at global and project scope", async () => {
    const { home, projectRoot, globalTarget, projectTarget, skill, synchronizer } = await fixture();
    const result = await synchronizer.sync([skill([globalTarget, projectTarget])]);
    expect(result.created).toHaveLength(10);
    expect(await fs.lstat(path.join(home, ".agents", "skills", "example"))).toBeDefined();
    expect(await fs.lstat(path.join(projectRoot, ".agents", "skills", "example"))).toBeDefined();
  });

  it("silently installs into a non-Git project without an exclude file", async () => {
    const { projectRoot, projectTarget, skill, synchronizer } = await fixture();
    const result = await synchronizer.sync([skill([projectTarget])]);
    expect(result.created).toHaveLength(5);
    await expect(fs.lstat(path.join(projectRoot, ".git", "info", "exclude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites or excludes unknown user content", async () => {
    const { projectRoot, projectTarget, skill, synchronizer, git } = await fixture();
    await git.run(projectRoot, ["init", "--quiet"]);
    const occupied = path.join(projectRoot, ".agents", "skills", "example");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "keep.txt"), "mine");
    const result = await synchronizer.sync([skill([projectTarget])]);
    expect(result.skipped.some((entry) => entry.includes("occupied"))).toBe(true);
    expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("mine");
    const exclude = await fs.readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/.agents/skills/example");
    expect(exclude).toContain("/.claude/skills/example");
  });

  it("removes only matching links and cleans its exclude block", async () => {
    const { projectRoot, projectTarget, skill, synchronizer, git } = await fixture();
    await git.run(projectRoot, ["init", "--quiet"]);
    const resolved = skill([projectTarget]);
    await synchronizer.sync([resolved]);
    const result = await synchronizer.sync([{ ...resolved, enabled: false }]);
    expect(result.removed).toHaveLength(5);
    const exclude = await fs.readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("agent-skills-manager project links");
  });

  it("preserves a stale path that no longer matches the recorded link", async () => {
    const { projectRoot, projectTarget, skill, synchronizer } = await fixture();
    const resolved = skill([projectTarget]);
    await synchronizer.sync([resolved]);
    const changedLink = path.join(projectRoot, ".agents", "skills", "example");
    await fs.unlink(changedLink);
    await fs.symlink(projectRoot, changedLink, "dir");
    const result = await synchronizer.sync([{ ...resolved, enabled: false }]);
    expect(result.skipped.some((entry) => entry.includes("no longer the managed symlink"))).toBe(true);
    expect(await fs.realpath(changedLink)).toBe(await fs.realpath(projectRoot));
  });

  it("validates every target before creating any link", async () => {
    const { home, globalTarget, skill, synchronizer } = await fixture();
    const missingTarget: ResolvedSkillTarget = {
      scope: "project",
      projectId: "missing",
      projectRoot: null,
      agents: ["codex"],
    };
    await expect(synchronizer.sync([skill([globalTarget, missingTarget])])).rejects.toThrow("is not bound");
    await expect(fs.lstat(path.join(home, ".agents", "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails on malformed exclude markers before creating links", async () => {
    const { projectRoot, projectTarget, skill, synchronizer, git } = await fixture();
    await git.run(projectRoot, ["init", "--quiet"]);
    await fs.writeFile(
      path.join(projectRoot, ".git", "info", "exclude"),
      "# BEGIN agent-skills-manager project links\n",
    );
    await expect(synchronizer.sync([skill([projectTarget])])).rejects.toThrow("malformed");
    await expect(fs.lstat(path.join(projectRoot, ".agents", "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aggregates nested project links in one repository exclude file", async () => {
    const { projectRoot, skill, synchronizer, git } = await fixture();
    await git.run(projectRoot, ["init", "--quiet"]);
    const firstRoot = path.join(projectRoot, "packages", "first");
    const secondRoot = path.join(projectRoot, "packages", "second");
    await fs.mkdir(firstRoot, { recursive: true });
    await fs.mkdir(secondRoot, { recursive: true });
    const targets: ResolvedSkillTarget[] = [firstRoot, secondRoot].map((root, index) => ({
      scope: "project",
      projectId: `project-${index}`,
      projectRoot: root,
      agents: ["codex"],
    }));
    await synchronizer.sync([skill(targets)]);
    const exclude = await fs.readFile(path.join(projectRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/packages/first/.agents/skills/example");
    expect(exclude).toContain("/packages/second/.agents/skills/example");
  });
});
