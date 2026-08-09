import path from "node:path";
import { agentIds, type ProjectBindingsConfig, type RegistryConfig, type ResolvedProject, type ResolvedSkill, type ResolvedSkillTarget } from "../core/types.js";
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

export function resolveProjects(
  registry: RegistryConfig,
  bindings: ProjectBindingsConfig,
): ResolvedProject[] {
  const resolved: ResolvedProject[] = [];
  const projectIdsByRoot = new Map<string, string>();
  for (const id of registry.projects) {
    const localPath = bindings.projects[id]?.path;
    if (!localPath) {
      resolved.push({ id, root: null, source: "unbound" });
      continue;
    }
    const root = path.resolve(localPath);
    if (root === path.parse(root).root) throw new UserError(`project ${id}.path cannot be a filesystem root`);
    const duplicate = projectIdsByRoot.get(root);
    if (duplicate) throw new UserError(`projects ${duplicate} and ${id} resolve to the same path`);
    projectIdsByRoot.set(root, id);
    resolved.push({ id, root, source: "local" });
  }
  return resolved;
}

export function resolveSkills(
  registry: RegistryConfig,
  paths: ProjectPaths,
  bindings: ProjectBindingsConfig = { projects: {} },
): ResolvedSkill[] {
  const projectRoots = new Map(resolveProjects(registry, bindings).map((project) => [project.id, project.root]));
  return Object.entries(registry.skills).map(([name, skill]) => {
    const sourceRoot =
      skill.source === "local"
        ? paths.root
        : safeJoin(paths.vendors, registry.sources[skill.source]?.path ?? skill.source, `source ${skill.source}.path`);
    const targets: ResolvedSkillTarget[] = skill.targets.map((target) => {
      const agents = target.agents.includes("*") ? [...agentIds] : target.agents.filter((id) => id !== "*");
      if (target.scope === "global") return { scope: "global", agents };
      const projectRoot = projectRoots.get(target.project) ?? null;
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
