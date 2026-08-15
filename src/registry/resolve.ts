import path from "node:path";
import { agentIds, type AgentId, type ProjectBindingsConfig, type RegistryConfig, type ResolvedProject, type ResolvedSkill, type ResolvedSkillTarget } from "../core/types.js";
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

export function resolveProjects(bindings: ProjectBindingsConfig): ResolvedProject[] {
  const resolved: ResolvedProject[] = [];
  const projectIdsByRoot = new Map<string, string>();
  for (const [id, install] of Object.entries(bindings.projects)) {
    const localPaths = install.paths;
    if (localPaths.length === 0) {
      resolved.push({ id, roots: [], source: "unbound" });
      continue;
    }
    const roots: string[] = [];
    for (const localPath of localPaths) {
      const root = path.resolve(localPath);
      if (root === path.parse(root).root) throw new UserError(`project ${id}.paths cannot contain a filesystem root`);
      const duplicate = projectIdsByRoot.get(root);
      if (duplicate && duplicate !== id) throw new UserError(`projects ${duplicate} and ${id} resolve to the same path`);
      projectIdsByRoot.set(root, id);
      if (!roots.includes(root)) roots.push(root);
    }
    resolved.push({ id, roots, source: "local" });
  }
  return resolved;
}

export function resolveSkills(
  registry: RegistryConfig,
  paths: ProjectPaths,
  bindings: ProjectBindingsConfig = { projects: {} },
): ResolvedSkill[] {
  const projectRoots = new Map(resolveProjects(bindings).map((project) => [project.id, project.roots]));
  // A Skill's global reach is committed; where it additionally lands on this machine is
  // read from local state, so the two are merged only at resolution time.
  const projectTargets = new Map<string, ResolvedSkillTarget[]>();
  for (const [projectId, install] of Object.entries(bindings.projects)) {
    for (const [name, target] of Object.entries(install.skills)) {
      const agents = target.agents.includes("*") ? [...agentIds] : target.agents.filter((id): id is AgentId => id !== "*");
      const existing = projectTargets.get(name) ?? [];
      existing.push({ scope: "project", projectId, projectRoots: projectRoots.get(projectId) ?? [], agents });
      projectTargets.set(name, existing);
    }
  }
  return Object.entries(registry.skills).map(([name, skill]) => {
    const sourceRoot =
      skill.source === "local"
        ? paths.root
        : safeJoin(paths.vendors, registry.sources[skill.source]?.path ?? skill.source, `source ${skill.source}.path`);
    const targets: ResolvedSkillTarget[] = skill.targets.map((target) => ({
      scope: "global" as const,
      agents: target.agents.includes("*") ? [...agentIds] : target.agents.filter((id): id is AgentId => id !== "*"),
    }));
    targets.push(...(projectTargets.get(name) ?? []));
    return {
      name,
      sourceId: skill.source,
      absolutePath: safeJoin(sourceRoot, skill.path, `skill ${name}.path`),
      enabled: skill.enabled,
      targets,
    };
  });
}
