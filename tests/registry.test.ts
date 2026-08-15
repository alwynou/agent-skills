import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateProjectBindings, validateRegistry } from "../src/registry/schema.js";
import { resolveProjects, resolveSkills } from "../src/registry/resolve.js";
import { projectPaths } from "../src/core/paths.js";

const globalTarget = (agents: string[] = ["codex"]) => [{ scope: "global", agents }];

describe("registry validation", () => {
  it("accepts local and git-backed skills with explicit targets", () => {
    const registry = validateRegistry({
      sources: { upstream: { type: "git", repo: "https://example.com/skills.git" } },
      skills: {
        local: { source: "local", path: "skills/local", enabled: true, targets: globalTarget(["*"]) },
        remote: { source: "upstream", path: "skills/remote", enabled: false, targets: globalTarget() },
      },
    });
    const resolved = resolveSkills(registry, projectPaths("/repo"));
    expect(resolved[0]?.targets[0]?.agents).toEqual(["codex", "claude", "kimi-code", "pi-agent", "opencode"]);
    expect(resolved[1]?.absolutePath).toBe(path.join("/repo", "vendors", "upstream", "skills", "remote"));
  });

  it("resolves project installations from machine state alone", () => {
    const registry = validateRegistry({
      sources: {},
      skills: {
        scoped: { source: "local", path: "skills/scoped", enabled: true, targets: [{ scope: "global", agents: ["codex"] }] },
      },
    });
    const bindings = validateProjectBindings({
      projects: {
        storefront: { paths: ["/work/storefront"], skills: { scoped: { agents: ["*"] } } },
        admin: { paths: ["/work/admin"], skills: {} },
      },
    });
    expect(resolveProjects(bindings)).toEqual([
      { id: "storefront", roots: ["/work/storefront"], source: "local" },
      { id: "admin", roots: ["/work/admin"], source: "local" },
    ]);

    const [skill] = resolveSkills(registry, projectPaths("/manager"), bindings);
    expect(skill?.targets[0]).toMatchObject({ scope: "global" });
    expect(skill?.targets[1]).toMatchObject({ scope: "project", projectId: "storefront", projectRoots: ["/work/storefront"] });
    expect(skill?.targets[1]?.agents).toHaveLength(5);
    // A project with no Skills installed contributes no target at all.
    expect(skill?.targets).toHaveLength(2);
  });

  it("refuses a registry that still carries project state", () => {
    expect(() => validateRegistry({ sources: {}, projects: ["app"], skills: {} }))
      .toThrow("registry.projects is no longer supported");
    expect(() => validateRegistry({
      sources: {}, skills: { scoped: { source: "local", path: "skills/scoped", enabled: true, targets: [{ scope: "project", project: "app", agents: ["*"] }] } },
    })).toThrow("reinstall it locally with --scope project");
  });

  it("requires explicit targets and rejects invalid target configurations", () => {
    expect(() => validateRegistry({ sources: {}, skills: { old: { source: "local", path: "skills/old", enabled: true, agents: ["codex"] } } })).toThrow("targets must be a list");
    // An enabled Skill may hold no global targets: it can be installed only into a
    // project on this machine, which the registry deliberately cannot see.
    expect(validateRegistry({ sources: {}, skills: { idle: { source: "local", path: "skills/idle", enabled: true, targets: [] } } }).skills.idle?.targets).toEqual([]);
    expect(() => validateRegistry({ sources: {}, skills: { bad: { source: "local", path: "skills/bad", enabled: true, targets: globalTarget(["mystery"]) } } })).toThrow("unsupported agent");
    expect(() => validateRegistry({ sources: {}, skills: { invalid: { source: "local", path: "skills/invalid", enabled: true, targets: [{ scope: "workspace", agents: ["codex"] }] } } })).toThrow("scope must be global");
  });

  it("rejects unsafe names, paths, project declarations, and bindings", () => {
    expect(() => validateRegistry({ sources: {}, skills: { "../escape": { source: "local", path: "skills/escape", enabled: true, targets: globalTarget() } } })).toThrow("lowercase letters");
    expect(() => validateProjectBindings({ projects: { app: { path: "../app" } } })).toThrow("must be absolute");
    expect(() => validateProjectBindings({ projects: { app: { paths: ["/app"], skills: { "Bad Name": { agents: ["codex"] } } } } }))
      .toThrow("invalid name Bad Name");
    expect(() => resolveProjects({ projects: { unsafe: { paths: ["/"], skills: {} } } })).toThrow("filesystem root");
    const escaping = validateRegistry({ sources: {}, skills: { unsafe: { source: "local", path: "../private", enabled: true, targets: globalTarget() } } });
    expect(() => resolveSkills(escaping, projectPaths("/repo"))).toThrow("escapes its source root");
  });

  it("rejects two logical projects bound to the same directory", () => {
    expect(() => resolveProjects({ projects: { one: { paths: ["/work/app"], skills: {} }, two: { paths: ["/work/app"], skills: {} } } }))
      .toThrow("resolve to the same path");
  });
});
