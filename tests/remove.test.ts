import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { SkillManager } from "../src/core/manager.js";
import { NodeFs } from "../src/core/fs.js";
import { projectPaths } from "../src/core/paths.js";
import { GitClient } from "../src/git/client.js";
import { RegistryStore } from "../src/registry/store.js";
import type { RegistryConfig } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

async function commitAll(root: string): Promise<void> {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
}

async function localFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-remove-local-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  await git(root, "init", "--quiet");
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", "example"), { recursive: true });
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: test\n---\n");
  const registry: RegistryConfig = {
    sources: {},
    skills: {
      example: {
        source: "local",
        path: "skills/example",
        enabled: true,
        targets: [{ scope: "global", agents: ["codex"] }],
      },
    },
  };
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), YAML.stringify(registry));
  await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), "sources: {}\n");
  await commitAll(root);
  await fs.writeFile(
    path.join(root, ".skill-manager", "projects.local.yaml"),
    YAML.stringify({ projects: { app: { paths: [projectRoot], skills: { example: { agents: ["*"] } } } } }),
  );
  const store = new RegistryStore(new NodeFs(), projectPaths(root));
  const manager = new SkillManager(new NodeFs(), new GitClient(), store, projectPaths(root), home);
  return { root, home, projectRoot, store, manager };
}

async function gitSourceFixture(shared: boolean) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-remove-git-"));
  temporaryDirectories.push(temporaryRoot);
  const source = path.join(temporaryRoot, "source");
  const root = path.join(temporaryRoot, "manager");
  const home = path.join(temporaryRoot, "home");
  await fs.mkdir(source);
  await git(source, "init", "--quiet");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
  for (const name of ["one", "two"]) {
    await fs.mkdir(path.join(source, "skills", name), { recursive: true });
    await fs.writeFile(path.join(source, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }
  await commitAll(source);
  const commit = await git(source, "rev-parse", "HEAD");

  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await fs.mkdir(path.join(root, "registry"));
  await fs.mkdir(path.join(root, ".skill-manager"));
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "--name", "upstream", source, "vendors/upstream");
  const skills: RegistryConfig["skills"] = {
    one: { source: "upstream", path: "skills/one", enabled: true, targets: [{ scope: "global", agents: ["codex"] }] },
  };
  if (shared) skills.two = { source: "upstream", path: "skills/two", enabled: true, targets: [{ scope: "global", agents: ["claude"] }] };
  const registry: RegistryConfig = {
    sources: { upstream: { type: "git", repo: source } },
    skills,
  };
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), YAML.stringify(registry));
  await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), YAML.stringify({ sources: { upstream: { commit } } }));
  await commitAll(root);
  const store = new RegistryStore(new NodeFs(), projectPaths(root));
  const manager = new SkillManager(new NodeFs(), new GitClient(), store, projectPaths(root), home);
  return { root, home, store, manager };
}

describe("skill removal", () => {
  it("removes project and global targets, then reinstalls a targetless Skill", async () => {
    const { home, projectRoot, store, manager } = await localFixture();
    await manager.sync();
    const projectRemoval = await manager.remove({
      skillName: "example", scope: "project", projectId: "app", all: false, dryRun: false, sync: true,
    });
    expect(projectRemoval.syncResult?.removed).toHaveLength(2);
    expect(await fs.realpath(path.join(home, ".agents", "skills", "example"))).toBeTruthy();
    await expect(fs.lstat(path.join(projectRoot, ".agents", "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });

    const globalRemoval = await manager.remove({
      skillName: "example", scope: "global", agents: ["codex"], all: false, dryRun: false, sync: true,
    });
    expect(globalRemoval.syncResult?.removed).toHaveLength(1);
    expect((await store.readRegistry()).skills.example).toMatchObject({ enabled: false, targets: [] });

    await manager.install({
      skillName: "example", scope: "global", agents: ["claude"], dryRun: false, sync: true,
    });
    expect((await store.readRegistry()).skills.example).toMatchObject({
      enabled: true,
      targets: [{ scope: "global", agents: ["claude"] }],
    });
  });

  it("dry-runs and no-ops without changing registry or links", async () => {
    const { root, projectRoot, manager } = await localFixture();
    await manager.sync();
    const registryBefore = await fs.readFile(path.join(root, "registry", "skills.yaml"), "utf8");
    const dryRun = await manager.remove({
      skillName: "example", scope: "project", projectId: "app", all: false, dryRun: true, sync: true,
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.links).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "registry", "skills.yaml"), "utf8")).toBe(registryBefore);
    expect(await fs.realpath(path.join(projectRoot, ".agents", "skills", "example"))).toBeTruthy();
    const noOp = await manager.remove({
      skillName: "example", scope: "project", projectId: "missing", all: false, dryRun: false, sync: true,
    });
    expect(noOp.noOp).toBe(true);
  });

  it("supports registry-only removal with --no-sync semantics", async () => {
    const { home, store, manager } = await localFixture();
    await manager.sync();
    const result = await manager.remove({
      skillName: "example", scope: "global", agents: ["codex"], all: false, dryRun: false, sync: false,
    });
    expect(result.syncResult).toBeNull();
    // The global target is gone from the registry, but the project installation is
    // machine state and survives untouched.
    expect((await store.readRegistry()).skills.example).toMatchObject({ enabled: true, targets: [] });
    expect(await fs.realpath(path.join(home, ".agents", "skills", "example"))).toBeTruthy();
  });

  it("physically deletes a clean local Skill and its managed links", async () => {
    const { root, home, store, manager } = await localFixture();
    await manager.sync();
    const result = await manager.delete({ skillName: "example", dryRun: false, sync: true });
    expect(result.skills).toEqual(["example"]);
    expect((await store.readRegistry()).skills.example).toBeUndefined();
    await expect(fs.lstat(path.join(root, "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(home, ".agents", "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a user replacement while deleting the owned local Skill", async () => {
    const { home, manager } = await localFixture();
    await manager.sync();
    const link = path.join(home, ".agents", "skills", "example");
    await fs.unlink(link);
    await fs.writeFile(link, "mine");
    const result = await manager.delete({ skillName: "example", dryRun: false, sync: true });
    expect(result.syncResult?.skipped).toContain(`${link} (no longer the managed symlink)`);
    expect(await fs.readFile(link, "utf8")).toBe("mine");
  });

  it("refuses to delete a local Skill with unknown content before changing state", async () => {
    const { root, store, manager } = await localFixture();
    await fs.writeFile(path.join(root, "skills", "example", "private.txt"), "mine");
    await expect(manager.delete({ skillName: "example", dryRun: false, sync: true })).rejects.toThrow("modified or untracked");
    expect((await store.readRegistry()).skills.example).toBeDefined();
    expect(await fs.readFile(path.join(root, "skills", "example", "private.txt"), "utf8")).toBe("mine");
  });

  it("refuses ignored local content before changing state", async () => {
    const { root, store, manager } = await localFixture();
    await fs.writeFile(path.join(root, ".gitignore"), "skills/example/private.txt\n");
    await fs.writeFile(path.join(root, "skills", "example", "private.txt"), "mine");
    await expect(manager.delete({ skillName: "example", dryRun: false, sync: true }))
      .rejects.toThrow("ignored content that deletion would destroy: skills/example/private.txt");
    expect((await store.readRegistry()).skills.example).toBeDefined();
    expect(await fs.readFile(path.join(root, "skills", "example", "private.txt"), "utf8")).toBe("mine");
  });

  it("deletes a vendor holding ignored build output and reports what went with it", async () => {
    const { root, store, manager } = await gitSourceFixture(false);
    await manager.sync();
    await fs.mkdir(path.join(root, "vendors", "upstream", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "vendors", "upstream", "node_modules", "index.js"), "built");

    const result = await manager.delete({ sourceId: "upstream", dryRun: false, sync: true });

    expect(result.ignoredPaths).toEqual(["node_modules/"]);
    expect((await store.readRegistry()).sources.upstream).toBeUndefined();
    await expect(fs.stat(path.join(root, "vendors", "upstream"))).rejects.toThrow();
  });

  it("does not mistake the central repository's own state for an uninitialized vendor's", async () => {
    const { root, store, manager } = await gitSourceFixture(false);
    await manager.sync();
    // A deinitialized submodule has no `.git`, so an unguarded `git -C` inside it reports
    // the central repository instead — whose ignored node_modules would look like a dirty
    // vendor and refuse every deletion.
    await git(root, "submodule", "deinit", "--force", "vendors/upstream");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "index.js"), "dependency");

    const result = await manager.delete({ sourceId: "upstream", dryRun: false, sync: true });

    expect(result.ignoredPaths).toEqual([]);
    expect((await store.readRegistry()).sources.upstream).toBeUndefined();
  });

  it("deletes one shared third-party Skill while retaining its source", async () => {
    const { root, home, store, manager } = await gitSourceFixture(true);
    await manager.sync();
    const result = await manager.delete({ skillName: "one", dryRun: false, sync: true });
    expect(result.retainedSource).toBe(true);
    const registry = await store.readRegistry();
    expect(registry.skills.one).toBeUndefined();
    expect(registry.skills.two).toBeDefined();
    expect(registry.sources.upstream).toBeDefined();
    expect(await fs.realpath(path.join(root, "vendors", "upstream"))).toBeTruthy();
    await expect(fs.lstat(path.join(home, ".agents", "skills", "one"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(path.join(home, ".claude", "skills", "two"))).toBeTruthy();
  });

  it("deletes an exclusive third-party source with its Skill", async () => {
    const { root, store, manager } = await gitSourceFixture(false);
    const result = await manager.delete({ skillName: "one", dryRun: false, sync: true });
    expect(result.retainedSource).toBe(false);
    expect((await store.readRegistry()).sources.upstream).toBeUndefined();
    expect((await store.readLock()).sources.upstream).toBeUndefined();
    await expect(fs.lstat(path.join(root, "vendors", "upstream"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, ".gitmodules"), "utf8")).not.toContain("vendors/upstream");
  });

  it("deletes every Skill belonging to an explicit source", async () => {
    const { root, store, manager } = await gitSourceFixture(true);
    await manager.sync();
    const result = await manager.delete({ sourceId: "upstream", dryRun: false, sync: true });
    expect(result.action).toBe("delete-source");
    expect(result.skills.sort()).toEqual(["one", "two"]);
    expect(Object.keys((await store.readRegistry()).skills)).toEqual([]);
    await expect(fs.lstat(path.join(root, "vendors", "upstream"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a dirty source before deleting links or registry records", async () => {
    const { root, home, store, manager } = await gitSourceFixture(false);
    await manager.sync();
    await fs.writeFile(path.join(root, "vendors", "upstream", "skills", "one", "SKILL.md"), "dirty");
    await expect(manager.delete({ sourceId: "upstream", dryRun: false, sync: true }))
      .rejects.toThrow("vendor has modified or untracked content: skills/one/SKILL.md");
    expect((await store.readRegistry()).skills.one).toBeDefined();
    expect(await fs.realpath(path.join(home, ".agents", "skills", "one"))).toBeTruthy();
  });
});
