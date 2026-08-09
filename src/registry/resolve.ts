import path from "node:path";
import { agentIds, type RegistryConfig, type ResolvedSkill } from "../core/types.js";
import type { ProjectPaths } from "../core/paths.js";
import { UserError } from "../core/errors.js";

function safeJoin(root: string, relativePath: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new UserError(`${label} escapes its source root`);
  }
  return resolved;
}

export function resolveSkills(registry: RegistryConfig, paths: ProjectPaths): ResolvedSkill[] {
  return Object.entries(registry.skills).map(([name, skill]) => {
    const sourceRoot =
      skill.source === "local"
        ? paths.root
        : safeJoin(paths.vendors, registry.sources[skill.source]?.path ?? skill.source, `source ${skill.source}.path`);
    const agents = skill.agents.includes("*") ? [...agentIds] : skill.agents.filter((id) => id !== "*");
    return {
      name,
      sourceId: skill.source,
      absolutePath: safeJoin(sourceRoot, skill.path, `skill ${name}.path`),
      enabled: skill.enabled,
      agents,
    };
  });
}
