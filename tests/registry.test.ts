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
      projects: [],
      skills: {
        local: { source: "local", path: "skills/local", enabled: true, targets: globalTarget(["*"]) },
        remote: { source: "upstream", path: "skills/remote", enabled: false, targets: globalTarget() },
      },
    });
    expect(registry.projects).toEqual([]);
    const resolved = resolveSkills(registry, projectPaths("/repo"));
    expect(resolved[0]?.targets[0]?.agents).toEqual(["codex", "claude", "kimi-code", "pi-agent", "opencode"]);
    expect(resolved[1]?.absolutePath).toBe(path.join("/repo", "vendors", "upstream", "skills", "remote"));
  });

  it("resolves logical projects only through local absolute bindings", () => {
    const registry = validateRegistry({
      sources: {},
      projects: ["storefront", "admin"],
      skills: {
        scoped: {
          source: "local",
          path: "skills/scoped",
          enabled: true,
          targets: [
            { scope: "global", agents: ["codex"] },
            { scope: "project", project: "storefront", agents: ["*"] },
            { scope: "project", project: "admin", agents: ["*"] },
          ],
        },
      },
    });
    const bindings = validateProjectBindings({ projects: { storefront: { path: "/work/storefront" } } });
    expect(resolveProjects(registry, bindings)).toEqual([
      { id: "storefront", roots: ["/work/storefront"], source: "local" },
      { id: "admin", roots: [], source: "unbound" },
    ]);
    const [skill] = resolveSkills(registry, projectPaths("/manager"), bindings);
    expect(skill?.targets[1]).toMatchObject({ projectId: "storefront", projectRoots: ["/work/storefront"] });
    expect(skill?.targets[1]?.agents).toHaveLength(5);
    expect(skill?.targets[2]).toMatchObject({ projectId: "admin", projectRoots: [] });
  });

  it("requires explicit targets and rejects invalid target configurations", () => {
    expect(() => validateRegistry({ sources: {}, skills: { old: { source: "local", path: "skills/old", enabled: true, agents: ["codex"] } } })).toThrow("targets must be a list");
    expect(() => validateRegistry({ sources: {}, projects: [], skills: { idle: { source: "local", path: "skills/idle", enabled: true, targets: [] } } })).toThrow("with no targets must be disabled");
    expect(validateRegistry({ sources: {}, projects: [], skills: { idle: { source: "local", path: "skills/idle", enabled: false, targets: [] } } }).skills.idle?.targets).toEqual([]);
    expect(() => validateRegistry({ sources: {}, projects: [], skills: { bad: { source: "local", path: "skills/bad", enabled: true, targets: globalTarget(["mystery"]) } } })).toThrow("unsupported agent");
    expect(() => validateRegistry({ sources: {}, projects: [], skills: { scoped: { source: "local", path: "skills/scoped", enabled: true, targets: [{ scope: "project", project: "missing", agents: ["codex"] }] } } })).toThrow("unknown project missing");
    expect(validateRegistry({ sources: {}, projects: ["app"], skills: { scoped: { source: "local", path: "skills/scoped", enabled: true, targets: [{ scope: "project", project: "app", agents: ["codex"] }] } } }).skills.scoped?.targets)
      .toEqual([{ scope: "project", project: "app", agents: ["codex"] }]);
    expect(() => validateRegistry({ sources: {}, projects: [], skills: { invalid: { source: "local", path: "skills/invalid", enabled: true, targets: [{ scope: "workspace", agents: ["codex"] }] } } })).toThrow("scope must be global or project");
  });

  it("rejects unsafe names, paths, project declarations, and bindings", () => {
    expect(() => validateRegistry({ sources: {}, skills: { "../escape": { source: "local", path: "skills/escape", enabled: true, targets: globalTarget() } } })).toThrow("lowercase letters");
    expect(() => validateRegistry({ sources: {}, projects: ["Bad Project"], skills: {} })).toThrow("lowercase letters");
    expect(() => validateRegistry({ sources: {}, projects: ["app", "app"], skills: {} })).toThrow("duplicates");
    expect(() => validateProjectBindings({ projects: { app: { path: "../app" } } })).toThrow("must be absolute");
    const registry = validateRegistry({ sources: {}, projects: ["unsafe"], skills: {} });
    expect(() => resolveProjects(registry, { projects: { unsafe: { paths: ["/"] } } })).toThrow("filesystem root");
    const escaping = validateRegistry({ sources: {}, projects: [], skills: { unsafe: { source: "local", path: "../private", enabled: true, targets: globalTarget() } } });
    expect(() => resolveSkills(escaping, projectPaths("/repo"))).toThrow("escapes its source root");
  });

  it("rejects two logical projects bound to the same directory", () => {
    const registry = validateRegistry({ sources: {}, projects: ["one", "two"], skills: {} });
    expect(() => resolveProjects(registry, { projects: { one: { paths: ["/work/app"] }, two: { paths: ["/work/app"] } } })).toThrow("resolve to the same path");
  });
});
