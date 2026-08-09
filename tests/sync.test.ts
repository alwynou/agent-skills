import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFs } from "../src/core/fs.js";
import { projectPaths } from "../src/core/paths.js";
import { RegistryStore } from "../src/registry/store.js";
import { Synchronizer } from "../src/installer/synchronizer.js";
import { builtInAdapters } from "../src/agents/adapter.js";
import type { ResolvedSkill } from "../src/core/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-test-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const skillPath = path.join(root, "skills", "example");
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), "---\nname: example\ndescription: test\n---\n");
  await fs.mkdir(path.join(root, ".skill-manager"), { recursive: true });
  await fs.writeFile(path.join(root, ".skill-manager", "managed-links.json"), '{"version":1,"links":[]}\n');
  const fsPort = new NodeFs();
  const synchronizer = new Synchronizer(fsPort, new RegistryStore(fsPort, projectPaths(root)), builtInAdapters(home));
  const skill: ResolvedSkill = {
    name: "example",
    sourceId: "local",
    absolutePath: skillPath,
    enabled: true,
    agents: ["codex", "claude", "kimi-code", "pi-agent", "opencode"],
  };
  return { root, home, skill, synchronizer };
}

describe("synchronizer", () => {
  it("creates idempotent links in a temporary home", async () => {
    const { home, skill, synchronizer } = await fixture();
    const first = await synchronizer.sync([skill]);
    expect(first.created).toHaveLength(5);
    const second = await synchronizer.sync([skill]);
    expect(second.created).toHaveLength(0);
    expect(second.unchanged).toHaveLength(5);
    expect(await fs.realpath(path.join(home, ".agents", "skills", "example"))).toBe(
      await fs.realpath(skill.absolutePath),
    );
    expect(await fs.realpath(path.join(home, ".kimi-code", "skills", "example"))).toBe(
      await fs.realpath(skill.absolutePath),
    );
    expect(await fs.realpath(path.join(home, ".pi", "agent", "skills", "example"))).toBe(
      await fs.realpath(skill.absolutePath),
    );
    expect(await fs.realpath(path.join(home, ".config", "opencode", "skills", "example"))).toBe(
      await fs.realpath(skill.absolutePath),
    );
  });

  it("never overwrites unknown user content", async () => {
    const { home, skill, synchronizer } = await fixture();
    const occupied = path.join(home, ".agents", "skills", "example");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "keep.txt"), "mine");
    const result = await synchronizer.sync([skill]);
    expect(result.skipped.some((entry) => entry.includes("occupied"))).toBe(true);
    expect(await fs.readFile(path.join(occupied, "keep.txt"), "utf8")).toBe("mine");
  });

  it("removes only a previously recorded matching link", async () => {
    const { home, skill, synchronizer } = await fixture();
    await synchronizer.sync([skill]);
    const disabled = { ...skill, enabled: false };
    const result = await synchronizer.sync([disabled]);
    expect(result.removed).toHaveLength(5);
    await expect(fs.lstat(path.join(home, ".agents", "skills", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
