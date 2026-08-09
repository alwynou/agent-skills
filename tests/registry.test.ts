import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateRegistry } from "../src/registry/schema.js";
import { resolveSkills } from "../src/registry/resolve.js";
import { projectPaths } from "../src/core/paths.js";

describe("registry validation", () => {
  it("accepts local and git-backed skills", () => {
    const registry = validateRegistry({
      sources: { upstream: { type: "git", repo: "https://example.com/skills.git" } },
      skills: {
        local: { source: "local", path: "skills/local", enabled: true, agents: ["*"] },
        remote: { source: "upstream", path: "skills/remote", enabled: false, agents: ["codex"] },
      },
    });
    expect(registry.projects).toEqual({});
    expect(registry.skills.local?.agents).toEqual(["*"]);
    const resolved = resolveSkills(registry, projectPaths("/repo"));
    expect(resolved[0]?.targets[0]?.agents).toEqual(["codex", "claude", "kimi-code", "pi-agent", "opencode"]);
    expect(resolved[1]?.absolutePath).toBe(
      path.join("/repo", "vendors", "upstream", "skills", "remote"),
    );
  });

  it("rejects a skill path that escapes its source", () => {
    const registry = validateRegistry({
      sources: {},
      skills: { unsafe: { source: "local", path: "../private", enabled: true, agents: ["codex"] } },
    });
    expect(() => resolveSkills(registry, projectPaths("/repo"))).toThrow("escapes its source root");
  });

  it("rejects unknown agents", () => {
    expect(() =>
      validateRegistry({
        sources: {},
        skills: { bad: { source: "local", path: "skills/bad", enabled: true, agents: ["mystery"] } },
      }),
    ).toThrow("unsupported agent");
  });

  it("accepts every built-in agent", () => {
    const registry = validateRegistry({
      sources: {},
      skills: {
        shared: {
          source: "local",
          path: "skills/shared",
          enabled: true,
          agents: ["codex", "claude", "kimi-code", "pi-agent", "opencode"],
        },
      },
    });
    expect(registry.skills.shared?.agents).toEqual(["codex", "claude", "kimi-code", "pi-agent", "opencode"]);
  });

  it("resolves absolute and relative projects with global and project targets", () => {
    const registry = validateRegistry({
      sources: {},
      projects: {
        relative: { path: "../relative-app" },
        absolute: { path: "/work/absolute-app" },
      },
      skills: {
        scoped: {
          source: "local",
          path: "skills/scoped",
          enabled: true,
          targets: [
            { scope: "global", agents: ["codex"] },
            { scope: "project", project: "relative", agents: ["*"] },
            { scope: "project", project: "absolute", agents: ["claude"] },
          ],
        },
      },
    });
    const [skill] = resolveSkills(registry, projectPaths("/manager"));
    expect(skill?.targets[1]).toMatchObject({ projectId: "relative", projectRoot: "/relative-app" });
    expect(skill?.targets[1]?.agents).toHaveLength(5);
    expect(skill?.targets[2]).toMatchObject({ projectId: "absolute", projectRoot: "/work/absolute-app" });
  });

  it("rejects invalid target configurations", () => {
    expect(() =>
      validateRegistry({
        sources: {},
        projects: { app: { path: "../app" } },
        skills: {
          mixed: {
            source: "local",
            path: "skills/mixed",
            enabled: true,
            agents: ["codex"],
            targets: [{ scope: "project", project: "app", agents: ["codex"] }],
          },
        },
      }),
    ).toThrow("exactly one of agents or targets");

    expect(() =>
      validateRegistry({
        sources: {},
        skills: {
          scoped: {
            source: "local",
            path: "skills/scoped",
            enabled: true,
            targets: [{ scope: "project", project: "missing", agents: ["codex"] }],
          },
        },
      }),
    ).toThrow("unknown project missing");

    expect(() =>
      validateRegistry({
        sources: {},
        skills: {
          invalid: {
            source: "local",
            path: "skills/invalid",
            enabled: true,
            targets: [{ scope: "workspace", agents: ["codex"] }],
          },
        },
      }),
    ).toThrow("scope must be global or project");
  });

  it("rejects unsafe skill names and filesystem-root projects", () => {
    expect(() =>
      validateRegistry({
        sources: {},
        skills: { "../escape": { source: "local", path: "skills/escape", enabled: true, agents: ["codex"] } },
      }),
    ).toThrow("lowercase letters");

    const registry = validateRegistry({ sources: {}, projects: { unsafe: { path: "/" } }, skills: {} });
    expect(() => resolveSkills(registry, projectPaths("/manager"))).toThrow("filesystem root");
  });
});
