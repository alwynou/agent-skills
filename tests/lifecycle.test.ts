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
import { changeCliArgs, changeMetadata, parseChangeArgs } from "../skills/manage-agent-skills/scripts/change-helpers.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function fixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-lifecycle-"));
  temporaryDirectories.push(temporaryRoot);
  const source = path.join(temporaryRoot, "source");
  const root = path.join(temporaryRoot, "manager");
  const home = path.join(temporaryRoot, "home");

  await fs.mkdir(path.join(source, "skills", "foo"), { recursive: true });
  await git(source, "init", "--quiet");
  await fs.writeFile(path.join(source, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: first\n---\n");
  const first = await commitAll(source, "first");

  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  await git(root, "init", "--quiet");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "--name", "upstream", source, "vendors/upstream");
  const registry: RegistryConfig = {
    sources: { upstream: { type: "git", repo: source } },
    projects: [],
    skills: {
      foo: { source: "upstream", path: "skills/foo", enabled: true, targets: [{ scope: "global", agents: ["codex"] }] },
    },
  };
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), YAML.stringify(registry));
  await fs.writeFile(path.join(root, ".skill-manager", "lock.yaml"), YAML.stringify({ sources: { upstream: { commit: first } } }));
  await commitAll(root, "fixture");

  const store = new RegistryStore(new NodeFs(), projectPaths(root));
  const manager = new SkillManager(new NodeFs(), new GitClient(), store, projectPaths(root), home);
  return { root, source, home, store, manager, first };
}

describe("source updates", () => {
  it("plans the lock and submodule as tracked changes, then moves both", async () => {
    const { root, source, store, manager, first } = await fixture();
    await manager.sync();
    await fs.writeFile(path.join(source, "skills", "foo", "SKILL.md"), "---\nname: foo\ndescription: second\n---\n");
    const second = await commitAll(source, "second");

    const planned = await manager.update({ sourceId: "upstream", dryRun: true, sync: false });
    expect(planned.noOp).toBe(false);
    expect(planned.candidate).toBe(second);
    expect(planned.locked).toBe(first);
    expect(planned.trackedChanges).toEqual([".skill-manager/lock.yaml", "vendors/upstream"]);
    expect(planned.applied).toBe(false);
    expect((await store.readLock()).sources.upstream?.commit).toBe(first);

    const applied = await manager.update({ sourceId: "upstream", dryRun: false, sync: true });
    expect(applied.applied).toBe(true);
    expect((await store.readLock()).sources.upstream?.commit).toBe(second);
    expect(await git(path.join(root, "vendors", "upstream"), "rev-parse", "HEAD")).toBe(second);
    expect(await fs.readFile(path.join(root, "vendors", "upstream", "skills", "foo", "SKILL.md"), "utf8")).toContain("second");
  });

  it("reports an already current source as a no-op with nothing to commit", async () => {
    const { manager } = await fixture();
    const plan = await manager.update({ sourceId: "upstream", dryRun: false, sync: false });
    expect(plan.noOp).toBe(true);
    expect(plan.trackedChanges).toEqual([]);
    expect(plan.applied).toBe(false);
  });
});

describe("enable and disable", () => {
  it("disables a Skill, drops its links, and re-enables it", async () => {
    const { home, store, manager } = await fixture();
    await manager.sync();
    const link = path.join(home, ".agents", "skills", "foo");
    expect(await fs.lstat(link)).toBeTruthy();

    const disabled = await manager.setEnabled({ skillName: "foo", enabled: false, dryRun: false, sync: true });
    expect(disabled.trackedChanges).toEqual(["registry/skills.yaml"]);
    expect(disabled.syncResult?.removed).toEqual([link]);
    expect((await store.readRegistry()).skills.foo?.enabled).toBe(false);
    await expect(fs.lstat(link)).rejects.toThrow();

    const enabled = await manager.setEnabled({ skillName: "foo", enabled: true, dryRun: false, sync: true });
    expect(enabled.syncResult?.created).toEqual([link]);
    expect((await store.readRegistry()).skills.foo?.enabled).toBe(true);
  });

  it("treats a redundant request as a no-op and leaves a dry run unapplied", async () => {
    const { store, manager } = await fixture();
    expect((await manager.setEnabled({ skillName: "foo", enabled: true, dryRun: false, sync: false })).noOp).toBe(true);

    const planned = await manager.setEnabled({ skillName: "foo", enabled: false, dryRun: true, sync: false });
    expect(planned.noOp).toBe(false);
    expect(planned.applied).toBe(false);
    expect(planned.trackedChanges).toEqual(["registry/skills.yaml"]);
    expect((await store.readRegistry()).skills.foo?.enabled).toBe(true);
  });

  it("refuses to enable a Skill that has no targets", async () => {
    const { store, manager } = await fixture();
    const registry = await store.readRegistry();
    registry.skills.foo = { ...registry.skills.foo!, enabled: false, targets: [] };
    await store.writeRegistry(registry);
    await expect(manager.setEnabled({ skillName: "foo", enabled: true, dryRun: false, sync: false }))
      .rejects.toThrow("has no targets");
  });
});

describe("change launcher actions", () => {
  it("maps update, enable, and disable onto CLI arguments and commit titles", () => {
    const update = parseChangeArgs(["--action", "update-source", "--source", "upstream"]);
    expect(changeCliArgs(update, { dryRun: true })).toEqual(["src/cli.ts", "update", "upstream", "--dry-run", "--no-sync", "--json"]);
    expect(changeMetadata(update)).toEqual({ title: "chore(skills): 更新 upstream source" });

    const disable = parseChangeArgs(["--action", "disable", "--skill", "foo"]);
    expect(changeCliArgs(disable, { sync: false })).toEqual(["src/cli.ts", "disable", "foo", "--no-sync", "--json"]);
    expect(changeMetadata(disable)).toEqual({ title: "chore(skills): 停用 foo skill" });
    expect(changeMetadata(parseChangeArgs(["--action", "enable", "--skill", "foo"])))
      .toEqual({ title: "chore(skills): 启用 foo skill" });

    expect(() => parseChangeArgs(["--action", "update-source", "--source", "upstream", "--skill", "foo"]))
      .toThrow("--skill is not allowed for update-source");
    expect(() => parseChangeArgs(["--action", "enable"])).toThrow("--skill is required for enable");
  });

  it("infers the project ID from the working directory when removing a project target", () => {
    const values = parseChangeArgs(["--action", "remove", "--skill", "foo", "--scope", "project"]);
    expect(values.has("--project")).toBe(false);
  });
});
