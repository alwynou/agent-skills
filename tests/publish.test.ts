import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { publish, touchesRuntime } from "../src/publish/publisher.js";
import { NodeCommand, type CommandPort, type CommandResult } from "../src/publish/process.js";
import type { MutationPlan } from "../src/command/mutations.js";
import type { SyncResultSummary } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

const emptySync: SyncResultSummary = { created: [], removed: [], unchanged: [], skipped: [] };

function removalPlan(trackedChanges: string[]): MutationPlan {
  return {
    action: "delete",
    skills: ["example"],
    sourceId: null,
    target: null,
    trackedChanges,
    links: [],
    retainedSource: false,
    ignoredPaths: [],
    noOp: false,
    applied: false,
    syncResult: null,
  };
}

type Override = (command: string, args: string[]) => CommandResult | null;

/** Records the commands publishing runs, and lets a test force one of them to fail. */
class RecordingCommand implements CommandPort {
  readonly calls: string[] = [];

  constructor(private readonly override: Override = () => null) {}

  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    this.calls.push(`${command} ${args[0] ?? ""}`);
    return this.override(command, args) ?? new NodeCommand().run(command, args, cwd);
  }
}

async function fixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-publish-"));
  temporaryDirectories.push(temporaryRoot);
  const root = path.join(temporaryRoot, "central");
  const origin = path.join(temporaryRoot, "origin.git");
  await execFileAsync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  await fs.mkdir(path.join(root, "registry"), { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", root]);
  await git(root, "config", "user.name", "Fixture User");
  await git(root, "config", "user.email", "fixture@example.com");
  await git(root, "remote", "add", "origin", origin);
  await fs.writeFile(path.join(root, "registry", "skills.yaml"), "skills: {}\n");
  await git(root, "add", "-A");
  await git(root, "commit", "--quiet", "-m", "fixture");
  await git(root, "push", "--quiet", "-u", "origin", "main");
  const registry = path.join(root, "registry", "skills.yaml");
  return { root, origin, registry, revision: await git(root, "rev-parse", "HEAD") };
}

describe("touchesRuntime", () => {
  it("scopes validation to the paths a change actually touches", () => {
    expect(touchesRuntime(["registry/skills.yaml", ".skill-manager/lock.yaml", "vendors/upstream", ".gitmodules"])).toBe(false);
    expect(touchesRuntime(["registry/skills.yaml", "src/core/manager.ts"])).toBe(true);
    expect(touchesRuntime(["skills/manage-agent-skills/SKILL.md"])).toBe(true);
    expect(touchesRuntime(["package-lock.json"])).toBe(true);
  });
});

describe("publish", () => {
  it("commits on main, syncs after the commit, and pushes without creating a branch", async () => {
    const { root, registry } = await fixture();
    const commands = new RecordingCommand();
    let syncedAtCommit: string | null = null;

    const result = await publish(commands, {
      root,
      title: "chore(skills): 删除 example skill",
      push: true,
      apply: async ({ dryRun }) => {
        if (!dryRun) await fs.appendFile(registry, "changed\n");
        return removalPlan(["registry/skills.yaml"]);
      },
      sync: async () => {
        syncedAtCommit = await git(root, "rev-parse", "HEAD");
        return { ...emptySync, removed: ["/somewhere/example"] };
      },
    });

    expect(result.validation).toBe("registry");
    expect(result.pushed).toBe(true);
    expect(result.pushError).toBeNull();
    expect(result.syncResult?.removed).toEqual(["/somewhere/example"]);
    expect(await git(root, "log", "-1", "--pretty=%s")).toBe("chore(skills): 删除 example skill");
    expect(await git(root, "branch", "--format=%(refname:short)")).toBe("main");
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await git(root, "rev-parse", "origin/main")).toBe(result.commit);

    // Links are only reconciled once the commit exists, so a failure before it can never
    // strand the machine.
    expect(syncedAtCommit).toBe(result.commit);
    expect(commands.calls).not.toContain("git switch");
    expect(commands.calls.some((call) => call.startsWith("npm"))).toBe(false);
  });

  it("tolerates planned paths that no longer match anything, such as a removed submodule", async () => {
    const { root, registry } = await fixture();
    const result = await publish(new RecordingCommand(), {
      root,
      title: "chore(skills): 删除 upstream source 及其 Skills",
      push: false,
      apply: async ({ dryRun }) => {
        if (!dryRun) await fs.appendFile(registry, "changed\n");
        return removalPlan(["registry/skills.yaml", "vendors/removed"]);
      },
      sync: async () => emptySync,
    });

    expect(result.commit).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(await git(root, "show", "--stat", "--pretty=", "HEAD")).toContain("registry/skills.yaml");
  });

  it("restores a clean main and never syncs when validation fails", async () => {
    const { root, registry, revision } = await fixture();
    // A runtime path forces the full check, which this fixture fails.
    const commands = new RecordingCommand((command) =>
      command === "npm" ? { status: 1, stdout: "", stderr: "check failed" } : null);
    let synced = false;

    await expect(publish(commands, {
      root,
      title: "chore(skills): 删除 example skill",
      push: true,
      apply: async ({ dryRun }) => {
        if (!dryRun) await fs.appendFile(registry, "changed\n");
        return removalPlan(["registry/skills.yaml", "src/core/manager.ts"]);
      },
      sync: async () => {
        synced = true;
        return emptySync;
      },
    })).rejects.toThrow("restored to a clean main");

    expect(synced).toBe(false);
    expect(await git(root, "rev-parse", "HEAD")).toBe(revision);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("reports a rejected push as a warning rather than failing the change", async () => {
    const { root, origin, registry } = await fixture();
    await fs.rm(origin, { recursive: true, force: true });
    const result = await publish(new RecordingCommand(), {
      root,
      title: "chore(skills): 删除 example skill",
      push: true,
      apply: async ({ dryRun }) => {
        if (!dryRun) await fs.appendFile(registry, "changed\n");
        return removalPlan(["registry/skills.yaml"]);
      },
      sync: async () => emptySync,
    });

    expect(result.commit).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(result.pushError).toBeTruthy();
  });

  it("applies a link-only change without touching main", async () => {
    const { root, revision } = await fixture();
    let appliedWithSync = false;

    const result = await publish(new RecordingCommand(), {
      root,
      title: "chore(skills): 移除 example 的 project 安装",
      push: true,
      apply: async ({ dryRun, sync }) => {
        if (!dryRun && sync) appliedWithSync = true;
        return removalPlan([]);
      },
      sync: async () => emptySync,
    });

    expect(appliedWithSync).toBe(true);
    expect(result.commit).toBeNull();
    expect(result.pushed).toBe(false);
    expect(await git(root, "rev-parse", "HEAD")).toBe(revision);
  });

  it("prefers the central repository's own identity and falls back per field", async () => {
    const { root, registry } = await fixture();
    await git(root, "config", "--unset", "user.email");
    const commands = new RecordingCommand((command, args) =>
      command === "git" && args[0] === "config" ? { status: 1, stdout: "", stderr: "" } : null);
    // The override above blanks every `git config` read, so a missing identity surfaces
    // as a refusal rather than an anonymous commit.
    await expect(publish(commands, {
      root,
      title: "chore(skills): 删除 example skill",
      push: false,
      apply: async () => removalPlan(["registry/skills.yaml"]),
      sync: async () => emptySync,
    })).rejects.toThrow("user.name and user.email are required");

    // With only a local name and a global email, publishing still resolves both.
    await git(root, "config", "--global", "--add", "user.email", "global@example.com");
    try {
      const result = await publish(new RecordingCommand(), {
        root,
        title: "chore(skills): 删除 example skill",
        push: false,
        apply: async ({ dryRun }) => {
          if (!dryRun) await fs.appendFile(registry, "changed\n");
          return removalPlan(["registry/skills.yaml"]);
        },
        sync: async () => emptySync,
      });
      expect(result.commit).toBeTruthy();
      expect(await git(root, "log", "-1", "--pretty=%an <%ae>")).toBe("Fixture User <global@example.com>");
    } finally {
      await execFileAsync("git", ["config", "--global", "--unset-all", "user.email", "global@example.com"]);
    }
  });

  it("refuses to publish from a dirty central repository", async () => {
    const { root, registry } = await fixture();
    await fs.appendFile(registry, "stray\n");
    await expect(publish(new RecordingCommand(), {
      root,
      title: "chore(skills): 删除 example skill",
      push: false,
      apply: async () => removalPlan(["registry/skills.yaml"]),
      sync: async () => emptySync,
    })).rejects.toThrow("uncommitted changes");
  });

  it("refuses to commit a path the plan did not declare", async () => {
    const { root, registry, revision } = await fixture();
    await expect(publish(new RecordingCommand(), {
      root,
      title: "chore(skills): 删除 example skill",
      push: false,
      apply: async ({ dryRun }) => {
        if (!dryRun) {
          await fs.appendFile(registry, "changed\n");
          await fs.writeFile(path.join(root, "unplanned.txt"), "surprise\n");
          await git(root, "add", "unplanned.txt");
        }
        return removalPlan(["registry/skills.yaml"]);
      },
      sync: async () => emptySync,
    })).rejects.toThrow("refusing to commit unexpected paths: unplanned.txt");

    expect(await git(root, "rev-parse", "HEAD")).toBe(revision);
  });
});
