import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFs } from "../src/core/fs.js";
import { projectPaths } from "../src/core/paths.js";
import { SkillManager } from "../src/core/manager.js";
import { RegistryStore } from "../src/registry/store.js";
import { GitClient } from "../src/git/client.js";
import { resolveSkills } from "../src/registry/resolve.js";

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
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), "sources: {}\nskills: {}\n");
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
      skillName: "foo", scope: "project", agents: ["*"], projectId: "owner-app",
      projectPath: projectRoot, dryRun: false, sync: true,
    });
    expect(installed.projectBinding).toEqual({ id: "owner-app", path: projectRoot, paths: [projectRoot] });
    // The registry keeps only the global reach; the project installation is local.
    expect((await store.readRegistry()).skills.foo?.targets).toEqual([{ scope: "global", agents: ["codex"] }]);
    expect(installed.trackedChanges).toEqual([]);
    expect((await store.readProjectBindings()).projects["owner-app"]).toEqual({
      paths: [projectRoot],
      skills: { foo: { agents: ["*"] } },
    });
    expect(installed.links.sort()).toEqual([
      path.join(projectRoot, ".agents", "skills", "foo"),
      path.join(projectRoot, ".claude", "skills", "foo"),
    ].sort());
    expect(await fs.realpath(path.join(projectRoot, ".agents", "skills", "foo"))).toBe(
      await fs.realpath(path.join(root, "vendors", "upstream", "skills", "foo")),
    );
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

  it("binds a second checkout of the same project and links the Skill into both", async () => {
    const { root, source, store, manager } = await fixture();
    const first = path.join(root, "worktree-a");
    const second = path.join(root, "worktree-b");
    await fs.mkdir(first);
    await fs.mkdir(second);
    await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: first, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });

    // The same logical project checked out twice: the second install adds a binding
    // instead of fighting the first one for it.
    const installed = await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: second, dryRun: false, sync: true,
    });

    expect(installed.projectBinding).toEqual({ id: "owner-app", path: second, paths: [first, second] });
    expect(installed.links.sort()).toEqual([
      path.join(first, ".claude", "skills", "foo"),
      path.join(second, ".claude", "skills", "foo"),
    ].sort());
    for (const projectRoot of [first, second]) {
      expect(await fs.realpath(path.join(projectRoot, ".claude", "skills", "foo"))).toBe(
        await fs.realpath(path.join(root, "vendors", "upstream", "skills", "foo")),
      );
    }
    expect((await store.readRegistry()).skills.foo?.targets).toEqual([]);
  });

  it("refuses a directory already bound to a different logical project", async () => {
    const { root, source, manager } = await fixture();
    const shared = path.join(root, "worktree");
    await fs.mkdir(shared);
    await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: shared, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });
    await expect(manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "other-app",
      projectPath: shared, dryRun: false, sync: true,
    })).rejects.toThrow("already bound to owner-app");
  });

  it("unbinds one checkout while keeping the rest of the project bound", async () => {
    const { root, source, manager } = await fixture();
    const first = path.join(root, "worktree-a");
    const second = path.join(root, "worktree-b");
    await fs.mkdir(first);
    await fs.mkdir(second);
    await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: first, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });
    await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: second, dryRun: false, sync: true,
    });

    await expect(manager.unbindProject("owner-app", second)).rejects.toThrow("still has managed links");

    await manager.remove({ skillName: "foo", all: true, dryRun: false, sync: true });
    expect(await manager.unbindProject("owner-app", second)).toEqual([first]);
    expect((await manager.listProjects()).find((project) => project.id === "owner-app")?.roots).toEqual([first]);
  });

  it("keeps a project installation out of the registry so it never reaches another device", async () => {
    const { root, source, store, manager } = await fixture();
    const projectRoot = path.join(root, "worktree");
    await fs.mkdir(projectRoot);
    await manager.install({
      skillName: "foo", scope: "project", agents: ["*"], projectId: "owner-app",
      projectPath: projectRoot, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });

    // The Skill and its pinned source are committed, so content stays reviewed; only the
    // placement is local. Replaying the registry alone on another device installs nothing.
    const committed = await store.readRegistry();
    expect(committed.skills.foo).toMatchObject({ source: "upstream", enabled: true, targets: [] });
    expect(JSON.stringify(committed)).not.toContain("owner-app");
    expect(JSON.stringify(committed)).not.toContain(projectRoot);
    expect((await store.readLock()).sources.upstream?.commit).toMatch(/^[0-9a-f]{40}$/);

    const elsewhere = resolveSkills(committed, projectPaths(root));
    expect(elsewhere.find((skill) => skill.name === "foo")?.targets).toEqual([]);
  });

  it("installs a project Skill for one agent that owns its own project directory", async () => {
    const { root, source, store, manager } = await fixture();
    const projectRoot = path.join(root, "worktree");
    await fs.mkdir(projectRoot);
    const installed = await manager.install({
      skillName: "foo", scope: "project", agents: ["claude"], projectId: "owner-app",
      projectPath: projectRoot, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });

    expect((await store.readRegistry()).skills.foo?.targets).toEqual([]);
    expect((await store.readProjectBindings()).projects["owner-app"]?.skills).toEqual({ foo: { agents: ["claude"] } });
    expect(installed.links).toEqual([path.join(projectRoot, ".claude", "skills", "foo")]);
    expect(installed.impliedAgents).toEqual([]);
    await expect(fs.lstat(path.join(projectRoot, ".agents", "skills", "foo"))).rejects.toThrow();
  });

  it("reports the agents that share .agents/skills when a project install names one of them", async () => {
    const { root, source, manager } = await fixture();
    const projectRoot = path.join(root, "worktree");
    await fs.mkdir(projectRoot);
    const installed = await manager.install({
      skillName: "foo", scope: "project", agents: ["kimi-code"], projectId: "owner-app",
      projectPath: projectRoot, repo: source, sourceId: "upstream", skillPath: "skills/foo",
      dryRun: false, sync: true,
    });

    // The link set cannot separate them: one .agents/skills entry serves the whole group.
    expect(installed.links).toEqual([path.join(projectRoot, ".agents", "skills", "foo")]);
    expect(installed.impliedAgents.sort()).toEqual(["codex", "opencode", "pi-agent"]);
  });
});
