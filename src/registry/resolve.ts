import path from "node:path";
import { agentIds, type RegistryConfig, type ResolvedSkill, type ResolvedSkillTarget } from "../core/types.js";
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
  const projectRoots = new Map<string, string>();
  const projectIdsByRoot = new Map<string, string>();
  for (const [id, project] of Object.entries(registry.projects)) {
    const root = path.resolve(paths.root, project.path);
    if (root === path.parse(root).root) throw new UserError(`project ${id}.path cannot be a filesystem root`);
    const duplicate = projectIdsByRoot.get(root);
    if (duplicate) throw new UserError(`projects ${duplicate} and ${id} resolve to the same path`);
    projectRoots.set(id, root);
    projectIdsByRoot.set(root, id);
  }

  return Object.entries(registry.skills).map(([name, skill]) => {
    const sourceRoot =
      skill.source === "local"
        ? paths.root
        : safeJoin(paths.vendors, registry.sources[skill.source]?.path ?? skill.source, `source ${skill.source}.path`);
    const configuredTargets = skill.targets ?? [{ scope: "global" as const, agents: skill.agents ?? [] }];
    const targets: ResolvedSkillTarget[] = configuredTargets.map((target) => {
      const agents = target.agents.includes("*") ? [...agentIds] : target.agents.filter((id) => id !== "*");
      if (target.scope === "global") return { scope: "global", agents };
      const projectRoot = projectRoots.get(target.project);
      if (!projectRoot) throw new UserError(`skill ${name} references unknown project ${target.project}`);
      return { scope: "project", projectId: target.project, projectRoot, agents };
    });
    return {
      name,
      sourceId: skill.source,
      absolutePath: safeJoin(sourceRoot, skill.path, `skill ${name}.path`),
      enabled: skill.enabled,
      targets,
    };
  });
}
