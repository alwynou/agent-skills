import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { commitOnMain } from "../skills/manage-agent-skills/scripts/publish.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

/**
 * Builds a central repository with a bare origin and a stub manager binary. The stub
 * stands in for `tsx src/cli.ts`: it records every invocation with the HEAD visible at
 * that moment, so a test can prove the ordering of apply, validate, commit, and sync.
 */
async function fixture(options: { failValidation?: boolean } = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-publish-"));
  temporaryDirectories.push(temporaryRoot);
  const root = path.join(temporaryRoot, "central");
  const origin = path.join(temporaryRoot, "origin.git");
  const log = path.join(temporaryRoot, "calls.log");

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

  const tsx = path.join(temporaryRoot, "fake-tsx");
  await fs.writeFile(
    tsx,
    [
      "#!/bin/sh",
      `printf '%s | %s\\n' "$2" "$(git -C ${JSON.stringify(root)} rev-parse HEAD)" >> ${JSON.stringify(log)}`,
      "case \"$2\" in",
      "  list)",
      options.failValidation ? "    echo 'registry broke' >&2; exit 1 ;;" : "    echo 'ok' ;;",
      "  sync)",
      "    echo 'created 0, removed 1, unchanged 0' ;;",
      "  *)",
      `    printf 'changed\\n' >> ${JSON.stringify(path.join(root, "registry", "skills.yaml"))}`,
      "    echo '{\"action\":\"delete\",\"skills\":[\"example\"],\"retainedSource\":false}' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await fs.chmod(tsx, 0o755);

  return { root, origin, tsx, log, revision: await git(root, "rev-parse", "HEAD") };
}

async function readLog(log: string): Promise<string[]> {
  return (await fs.readFile(log, "utf8")).trim().split("\n");
}

describe("commitOnMain", () => {
  it("commits on main, syncs after the commit, and pushes without creating a branch", async () => {
    const { root, tsx, log, revision } = await fixture();
    const result = commitOnMain({
      root,
      tsx,
      plan: { trackedChanges: ["registry/skills.yaml"] },
      title: "chore(skills): 删除 example skill",
      applyArgs: ["src/cli.ts", "delete", "example", "--no-sync", "--json"],
      syncArgs: ["src/cli.ts", "sync"],
      push: true,
    });

    expect(result.validation).toBe("registry");
    expect(result.pushed).toBe(true);
    expect(result.pushError).toBeNull();
    expect(result.action).toBe("delete");
    expect(await git(root, "log", "-1", "--pretty=%s")).toBe("chore(skills): 删除 example skill");
    expect(await git(root, "branch", "--format=%(refname:short)")).toBe("main");
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect(await git(root, "rev-parse", "origin/main")).toBe(result.commit);

    // apply and validate observe the pre-change revision; sync only runs once the
    // commit exists, so a failure before it can never strand the machine's links.
    const calls = await readLog(log);
    expect(calls.map((entry) => entry.split(" | ")[0])).toEqual(["delete", "list", "sync"]);
    expect(calls[0]).toContain(revision);
    expect(calls[1]).toContain(revision);
    expect(calls[2]).toContain(result.commit);
  });

  it("tolerates planned paths that no longer match anything, such as a removed submodule", async () => {
    const { root, tsx } = await fixture();
    const result = commitOnMain({
      root,
      tsx,
      plan: { trackedChanges: ["registry/skills.yaml", "vendors/removed"] },
      title: "chore(skills): 删除 upstream source 及其 Skills",
      applyArgs: ["src/cli.ts", "delete", "--source", "upstream", "--no-sync", "--json"],
      syncArgs: ["src/cli.ts", "sync"],
      push: false,
    });

    expect(result.commit).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(await git(root, "show", "--stat", "--pretty=", "HEAD")).toContain("registry/skills.yaml");
  });

  it("restores a clean main and leaves links untouched when validation fails", async () => {
    const { root, tsx, log, revision } = await fixture({ failValidation: true });
    expect(() => commitOnMain({
      root,
      tsx,
      plan: { trackedChanges: ["registry/skills.yaml"] },
      title: "chore(skills): 删除 example skill",
      applyArgs: ["src/cli.ts", "delete", "example", "--no-sync", "--json"],
      syncArgs: ["src/cli.ts", "sync"],
      push: true,
    })).toThrow("restored to a clean main");

    expect(await git(root, "rev-parse", "HEAD")).toBe(revision);
    expect(await git(root, "status", "--porcelain")).toBe("");
    expect((await readLog(log)).map((entry) => entry.split(" | ")[0])).toEqual(["delete", "list"]);
  });

  it("reports a rejected push as a warning rather than failing the change", async () => {
    const { root, origin, tsx } = await fixture();
    await fs.rm(origin, { recursive: true, force: true });
    const result = commitOnMain({
      root,
      tsx,
      plan: { trackedChanges: ["registry/skills.yaml"] },
      title: "chore(skills): 删除 example skill",
      applyArgs: ["src/cli.ts", "delete", "example", "--no-sync", "--json"],
      syncArgs: ["src/cli.ts", "sync"],
      push: true,
    });

    expect(result.commit).toBeTruthy();
    expect(result.pushed).toBe(false);
    expect(result.pushError).toBeTruthy();
    expect(result.syncOutput).toContain("removed 1");
  });
});
