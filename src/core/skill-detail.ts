import path from "node:path";
import YAML from "yaml";
import type { FsPort } from "./fs.js";
import type { AgentId, ResolvedSkill } from "./types.js";

export interface SkillDetailTarget {
  scope: "global" | "project";
  projectId: string | null;
  /** Every checkout of the project bound on this machine; empty when unbound. */
  projectRoots: string[];
  agents: AgentId[];
}

export interface SkillDetail {
  name: string;
  /** SKILL.md frontmatter's name field. */
  title: string | null;
  /** SKILL.md frontmatter's description field. */
  description: string | null;
  sourceId: string;
  repo: string | null;
  lockedCommit: string | null;
  skillPath: string;
  absolutePath: string;
  enabled: boolean;
  /** Whether SKILL.md exists on disk. */
  present: boolean;
  targets: SkillDetailTarget[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Parse the YAML block wrapped in leading `---` fences of a SKILL.md file. */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  const block = match[1] ?? "";
  if (block.trim() === "") return {};
  try {
    const parsed = YAML.parse(block);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function frontmatterString(frontmatter: Record<string, unknown>, key: string): string | null {
  const value = frontmatter[key];
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/** Describe a resolved Skill: its SKILL.md frontmatter and every configured target. */
export async function describeSkill(
  fsPort: FsPort,
  skill: ResolvedSkill,
  context: { repo: string | null; lockedCommit: string | null; skillPath: string },
): Promise<SkillDetail> {
  let present = false;
  let frontmatter: Record<string, unknown> = {};
  try {
    const content = await fsPort.readFile(path.join(skill.absolutePath, "SKILL.md"));
    present = true;
    frontmatter = parseFrontmatter(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return {
    name: skill.name,
    title: present ? frontmatterString(frontmatter, "name") : null,
    description: present ? frontmatterString(frontmatter, "description") : null,
    sourceId: skill.sourceId,
    repo: context.repo,
    lockedCommit: context.lockedCommit,
    skillPath: context.skillPath,
    absolutePath: skill.absolutePath,
    enabled: skill.enabled,
    present,
    targets: skill.targets.map((target) =>
      target.scope === "global"
        ? { scope: "global" as const, projectId: null, projectRoots: [], agents: target.agents }
        : {
            scope: "project" as const,
            projectId: target.projectId,
            projectRoots: target.projectRoots,
            agents: target.agents,
          },
    ),
  };
}

/** Render a SkillDetail as multi-line text suitable for printing to a terminal. */
export function formatSkillDetail(detail: SkillDetail): string {
  const lines: string[] = [detail.title ?? detail.name];
  if (detail.description) {
    lines.push("", detail.description);
  }
  lines.push("");
  lines.push(`name: ${detail.name}`);
  if (detail.sourceId === "local") {
    lines.push("source: local");
  } else {
    lines.push(`source: ${detail.sourceId}`);
    if (detail.repo) lines.push(`repo: ${detail.repo}`);
    if (detail.lockedCommit) lines.push(`locked commit: ${detail.lockedCommit}`);
  }
  lines.push(`path: ${detail.skillPath}`);
  lines.push(`absolute: ${detail.absolutePath}`);
  lines.push(`enabled: ${detail.enabled ? "yes" : "no"}`);
  lines.push(`SKILL.md: ${detail.present ? "present" : "missing"}`);
  if (detail.targets.length === 0) {
    lines.push("", "targets: none");
  } else {
    lines.push("", "targets:");
    for (const target of detail.targets) {
      const agents = target.agents.join(", ");
      if (target.scope === "global") {
        lines.push(`  global: ${agents}`);
      } else {
        const binding = target.projectRoots.length > 0
          ? `bound at ${target.projectRoots.join(", ")}`
          : "not bound on this device";
        lines.push(`  project ${target.projectId}: ${agents} (${binding})`);
      }
    }
  }
  return lines.join("\n");
}
