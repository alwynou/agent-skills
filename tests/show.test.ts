import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFs } from "../src/core/fs.js";
import { describeSkill, formatSkillDetail, parseFrontmatter } from "../src/core/skill-detail.js";
import type { AgentId, ResolvedSkill } from "../src/core/types.js";

const fsPort = new NodeFs();

function skillLiteral(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name: "demo",
    sourceId: "local",
    absolutePath: "/tmp/demo",
    enabled: true,
    targets: [{ scope: "global", agents: ["codex"] }],
    ...overrides,
  };
}

async function temporarySkill(content: string | null, overrides: Partial<ResolvedSkill> = {}): Promise<{ root: string; skill: ResolvedSkill }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-show-"));
  const skillRoot = path.join(root, "skills", "demo");
  await fs.mkdir(skillRoot, { recursive: true });
  if (content !== null) await fs.writeFile(path.join(skillRoot, "SKILL.md"), content, "utf8");
  const skill = skillLiteral({ absolutePath: skillRoot, ...overrides });
  return { root, skill };
}

describe("parseFrontmatter", () => {
  it("parses a well-formed frontmatter block", () => {
    const content = "---\nname: Demo Skill\ndescription: Does useful things.\n---\n\n# Body text";
    expect(parseFrontmatter(content)).toEqual({ name: "Demo Skill", description: "Does useful things." });
  });

  it("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("# Demo\n\nplain text")).toEqual({});
  });

  it("returns {} when the frontmatter block is empty", () => {
    expect(parseFrontmatter("---\n---\n# Body")).toEqual({});
  });

  it("returns {} for malformed YAML instead of throwing", () => {
    expect(parseFrontmatter("---\nname: [unclosed\n---\n")).toEqual({});
    expect(() => parseFrontmatter("---\nname: [unclosed\n---\n")).not.toThrow();
  });

  it("returns {} when the parsed value is not an object", () => {
    expect(parseFrontmatter("---\njust a scalar\n---\n")).toEqual({});
    expect(parseFrontmatter("---\n- a\n- b\n---\n")).toEqual({});
  });
});

describe("describeSkill", () => {
  it("reads SKILL.md and exposes frontmatter fields", async () => {
    const { root, skill } = await temporarySkill("---\nname: Demo Skill\ndescription: Does things.\n---\n\nBody\n");
    try {
      const detail = await describeSkill(fsPort, skill, { repo: null, lockedCommit: null, skillPath: "skills/demo" });
      expect(detail).toMatchObject({
        name: "demo",
        title: "Demo Skill",
        description: "Does things.",
        sourceId: "local",
        repo: null,
        lockedCommit: null,
        skillPath: "skills/demo",
        absolutePath: skill.absolutePath,
        enabled: true,
        present: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports present false with null fields when SKILL.md is missing", async () => {
    const { root, skill } = await temporarySkill(null);
    try {
      const detail = await describeSkill(fsPort, skill, { repo: null, lockedCommit: null, skillPath: "skills/demo" });
      expect(detail.present).toBe(false);
      expect(detail.title).toBeNull();
      expect(detail.description).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rethrows IO errors other than ENOENT", async () => {
    const { root, skill } = await temporarySkill("body only");
    try {
      // SKILL.md is a directory, so readFile fails with EISDIR, not ENOENT.
      await fs.rm(path.join(skill.absolutePath, "SKILL.md"));
      await fs.mkdir(path.join(skill.absolutePath, "SKILL.md"));
      await expect(describeSkill(fsPort, skill, { repo: null, lockedCommit: null, skillPath: "skills/demo" })).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("maps global and project targets, carrying repo and locked commit", async () => {
    const { root, skill } = await temporarySkill("---\nname: Demo\n---\n", {
      sourceId: "upstream",
      targets: [
        { scope: "global", agents: ["codex", "claude"] },
        { scope: "project", projectId: "storefront", projectRoots: ["/dev/storefront"], agents: ["pi-agent"] },
        { scope: "project", projectId: "admin", projectRoots: [], agents: ["pi-agent"] },
      ] as ResolvedSkill["targets"],
    });
    try {
      const detail = await describeSkill(fsPort, skill, {
        repo: "https://example.com/skills.git",
        lockedCommit: "abc123",
        skillPath: "skills/demo",
      });
      expect(detail.repo).toBe("https://example.com/skills.git");
      expect(detail.lockedCommit).toBe("abc123");
      expect(detail.targets).toEqual([
        { scope: "global", projectId: null, projectRoots: [], agents: ["codex", "claude"] },
        { scope: "project", projectId: "storefront", projectRoots: ["/dev/storefront"], agents: ["pi-agent"] },
        { scope: "project", projectId: "admin", projectRoots: [], agents: ["pi-agent"] },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles a present SKILL.md without frontmatter", async () => {
    const { root, skill } = await temporarySkill("# Demo\n\nplain body\n");
    try {
      const detail = await describeSkill(fsPort, skill, { repo: null, lockedCommit: null, skillPath: "skills/demo" });
      expect(detail.present).toBe(true);
      expect(detail.title).toBeNull();
      expect(detail.description).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("formatSkillDetail", () => {
  it("renders a local global skill without repo or commit", () => {
    const detail = {
      name: "demo",
      title: "Demo Skill",
      description: "Does things.",
      sourceId: "local",
      repo: null,
      lockedCommit: null,
      skillPath: "skills/demo",
      absolutePath: "/repo/skills/demo",
      enabled: true,
      present: true,
      targets: [{ scope: "global" as const, projectId: null, projectRoots: [], agents: ["codex", "claude"] as AgentId[] }],
    };
    const output = formatSkillDetail(detail);
    expect(output.startsWith("Demo Skill\n")).toBe(true);
    expect(output).toContain("Does things.");
    expect(output).toContain("source: local");
    expect(output).not.toContain("repo:");
    expect(output).not.toContain("locked commit:");
    expect(output).toContain("path: skills/demo");
    expect(output).toContain("absolute: /repo/skills/demo");
    expect(output).toContain("enabled: yes");
    expect(output).toContain("SKILL.md: present");
    expect(output).toContain("  global: codex, claude");
  });

  it("renders git source repo and locked commit", () => {
    const output = formatSkillDetail({
      name: "demo",
      title: null,
      description: null,
      sourceId: "upstream",
      repo: "https://example.com/skills.git",
      lockedCommit: "abc1234",
      skillPath: "skills/demo",
      absolutePath: "/repo/vendors/upstream/skills/demo",
      enabled: false,
      present: false,
      targets: [],
    });
    expect(output).toContain("source: upstream");
    expect(output).toContain("repo: https://example.com/skills.git");
    expect(output).toContain("locked commit: abc1234");
    expect(output).toContain("enabled: no");
    expect(output).toContain("SKILL.md: missing");
    expect(output).toContain("targets: none");
  });

  it("marks project targets as bound or not bound on this device", () => {
    const output = formatSkillDetail({
      name: "demo",
      title: "Demo",
      description: "Does things.",
      sourceId: "local",
      repo: null,
      lockedCommit: null,
      skillPath: "skills/demo",
      absolutePath: "/repo/skills/demo",
      enabled: true,
      present: true,
      targets: [
        { scope: "project" as const, projectId: "storefront", projectRoots: ["/dev/storefront"], agents: ["pi-agent"] as AgentId[] },
        { scope: "project" as const, projectId: "admin", projectRoots: [], agents: ["pi-agent"] as AgentId[] },
      ],
    });
    expect(output).toContain("  project storefront: pi-agent (bound at /dev/storefront)");
    expect(output).toContain("  project admin: pi-agent (not bound on this device)");
  });
});
