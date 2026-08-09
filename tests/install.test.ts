import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFs } from "../src/core/fs.js";
import { projectPaths } from "../src/core/paths.js";
import { SkillManager } from "../src/core/manager.js";
import { RegistryStore } from "../src/registry/store.js";
import { GitClient } from "../src/git/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function git(gitClient: GitClient, cwd: string, args: string[]) {
  return gitClient.run(cwd, args);
}

async function fixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-install-test-"));
  temporaryDirectories.push(temporaryRoot);
  const root = path.join(temporaryRoot, "manager");
  const source = path.join(temporaryRoot, "source");
  const home = path.join(temporaryRoot, "home");
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  await fs.mkdir(path.join(source, "skills", "foo"), { recursive: true });
  await fs.writeFile(path.join(source, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: test\n---\n");
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), "sources: {}\nprojects: []\nskills: {}\n");
  await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), "sources: {}\n");
  const gitClient = new GitClient();
  await git(gitClient, root, ["init", "--quiet"]);
  await git(gitClient, source, ["init", "--quiet"]);
  await git(gitClient, source, ["config", "user.name", "Test"]);
  await git(gitClient, source, ["config", "user.email", "test@example.com"]);
  await git(gitClient, source, ["add", "."]);
  await git(gitClient, source, ["commit", "--quiet", "-m", "add foo"]);
  const fsPort = new NodeFs();
  const paths = projectPaths(root);
  const store = new RegistryStore(fsPort, paths);
  const manager = new SkillManager(fsPort, gitClient, store, paths, home);
  return { root, source, home, store, manager };
}

describe("skill installation", () => {
  it("resolves and pins an explicit non-default ref", async () => {
    const { source, store, manager } = await fixture();
    const gitClient = new GitClient();
    const defaultBranch = await git(gitClient, source, ["branch", "--show-current"]);
    await fs.writeFile(path.join(source, "skills", "foo", "feature.txt"), "feature\n");
    await git(gitClient, source, ["switch", "--quiet", "-c", "feature"]);
    await git(gitClient, source, ["add", "."]);
    await git(gitClient, source, ["commit", "--quiet", "-m", "feature"]);
    const featureCommit = await git(gitClient, source, ["rev-parse", "HEAD"]);
    await git(gitClient, source, ["switch", "--quiet", defaultBranch]);

    await manager.install({
      skillName: "foo", scope: "global", agents: ["codex"], repo: source, sourceId: "upstream",
      skillPath: "skills/foo", ref: "feature", dryRun: false, sync: false,
    });
    expect((await store.readLock()).sources.upstream?.commit).toBe(featureCommit);
  });

  it("rejects unsafe identifiers before fetching", async () => {
    const { manager } = await fixture();
    await expect(manager.install({
      skillName: "foo", scope: "global", agents: ["codex"], repo: "/missing",
      sourceId: "../escape", skillPath: "skills/foo", dryRun: true, sync: false,
    })).rejects.toThrow("source ID must use lowercase");
  });

  it("dry-runs and then imports, pins, registers, and selectively syncs a new source", async () => {
    const { root, source, home, store, manager } = await fixture();
    const request = {
      skillName: "foo",
      scope: "global" as const,
      agents: ["codex" as const],
      repo: source,
      sourceId: "upstream",
      skillPath: "skills/foo",
      dryRun: true,
      sync: true,
    };
    const plan = await manager.install(request);
    expect(plan.source.added).toBe(true);
    expect(plan.trackedChanges).toEqual(expect.arrayContaining([".gitmodules", "vendors/upstream", "registry/skills.yaml", ".skill-manager/lock.yaml"]));
    await expect(fs.lstat(path.join(root, ".gitmodules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.readRegistry()).skills.foo).toBeUndefined();

    const applied = await manager.install({ ...request, dryRun: false });
    expect(applied.applied).toBe(true);
    expect((await store.readRegistry()).skills.foo?.targets).toEqual([{ scope: "global", agents: ["codex"] }]);
    expect((await store.readLock()).sources.upstream?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await fs.realpath(path.join(home, ".agents", "skills", "foo"))).toBe(
      await fs.realpath(path.join(root, "vendors", "upstream", "skills", "foo")),
    );
  });

  it("adds a project target and binding without duplicating an existing skill", async () => {
    const { root, source, store, manager } = await fixture();
    await manager.install({
      skillName: "foo", scope: "global", agents: ["codex"], repo: source, sourceId: "upstream",
      skillPath: "skills/foo", dryRun: false, sync: true,
    });
    const projectRoot = path.join(root, "worktree");
    await fs.mkdir(projectRoot);
    const installed = await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: projectRoot, dryRun: false, sync: true,
    });
    expect(installed.projectBinding).toEqual({ id: "owner-app", path: projectRoot });
    expect((await store.readRegistry()).skills.foo?.targets).toEqual([
      { scope: "global", agents: ["codex"] },
      { scope: "project", project: "owner-app", agents: ["claude"] },
    ]);
    expect(await fs.realpath(path.join(projectRoot, ".claude", "skills", "foo"))).toBe(
      await fs.realpath(path.join(root, "vendors", "upstream", "skills", "foo")),
    );
    const repeat = await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: projectRoot, dryRun: true, sync: true,
    });
    expect(repeat.trackedChanges).toEqual([]);
    expect(repeat.localChanges).toEqual([]);
  });
});
