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
    expect(registry.skills.local?.agents).toEqual(["*"]);
    expect(resolveSkills(registry, projectPaths("/repo"))[1]?.absolutePath).toBe(
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
});
