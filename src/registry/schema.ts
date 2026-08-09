import path from "node:path";
import { agentIds, type AgentId, type LockConfig, type ProjectBindingsConfig, type RegistryConfig, type SkillTargetConfig } from "../core/types.js";
import { UserError } from "../core/errors.js";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateAgents(value: unknown, label: string): Array<AgentId | "*"> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UserError(`${label} must be a non-empty list`);
  }
  return value.map((agent) => {
    if (agent === "*" || (typeof agent === "string" && agentIds.includes(agent as AgentId))) {
      return agent as AgentId | "*";
    }
    throw new UserError(`${label} has unsupported agent ${String(agent)}`);
  });
}

export function validateRegistry(value: unknown): RegistryConfig {
  if (!isRecord(value)) throw new UserError("registry must be a mapping");
  const sourceInput = value.sources ?? {};
  const projectInput = value.projects ?? [];
  const skillInput = value.skills ?? {};
  if (!isRecord(sourceInput)) throw new UserError("registry.sources must be a mapping");
  if (!Array.isArray(projectInput)) throw new UserError("registry.projects must be a list");
  if (!isRecord(skillInput)) throw new UserError("registry.skills must be a mapping");

  const sources: RegistryConfig["sources"] = {};
  for (const [id, candidate] of Object.entries(sourceInput)) {
    if (!isRecord(candidate) || candidate.type !== "git") {
      throw new UserError(`source ${id} must have type: git`);
    }
    sources[id] = {
      type: "git",
      repo: requiredString(candidate.repo, `source ${id}.repo`),
      ...(typeof candidate.path === "string" ? { path: candidate.path } : {}),
    };
  }

  const projects = projectInput.map((candidate, index) => {
    const id = requiredString(candidate, `registry.projects[${index}]`);
    if (!skillNamePattern.test(id)) throw new UserError(`project ${id} must use lowercase letters, numbers, and single hyphens`);
    return id;
  });
  if (new Set(projects).size !== projects.length) throw new UserError("registry.projects must not contain duplicates");

  const skills: RegistryConfig["skills"] = {};
  for (const [name, candidate] of Object.entries(skillInput)) {
    if (!skillNamePattern.test(name)) {
      throw new UserError(`skill ${name} must use lowercase letters, numbers, and single hyphens`);
    }
    if (!isRecord(candidate)) throw new UserError(`skill ${name} must be a mapping`);
    const source = requiredString(candidate.source, `skill ${name}.source`);
    if (source !== "local" && !(source in sources)) {
      throw new UserError(`skill ${name} references unknown source ${source}`);
    }
    if (typeof candidate.enabled !== "boolean") {
      throw new UserError(`skill ${name}.enabled must be a boolean`);
    }
    if (!Array.isArray(candidate.targets) || candidate.targets.length === 0) {
      throw new UserError(`skill ${name}.targets must be a non-empty list`);
    }
    const targets: SkillTargetConfig[] = candidate.targets.map((target, index) => {
      const label = `skill ${name}.targets[${index}]`;
      if (!isRecord(target)) throw new UserError(`${label} must be a mapping`);
      const targetAgents = validateAgents(target.agents, `${label}.agents`);
      if (target.scope === "global") {
        if (target.project !== undefined) throw new UserError(`${label}.project is not allowed for global scope`);
        return { scope: "global", agents: targetAgents };
      }
      if (target.scope === "project") {
        const project = requiredString(target.project, `${label}.project`);
        if (!projects.includes(project)) throw new UserError(`${label} references unknown project ${project}`);
        if (targetAgents.length !== 1 || targetAgents[0] !== "*") {
          throw new UserError(`${label}.agents must be ["*"] because project Skills are shared by all supported agents`);
        }
        return { scope: "project", project, agents: ["*"] };
      }
      throw new UserError(`${label}.scope must be global or project`);
    });
    skills[name] = {
      source,
      path: requiredString(candidate.path, `skill ${name}.path`),
      enabled: candidate.enabled,
      targets,
    };
  }
  return { sources, projects, skills };
}

export function validateProjectBindings(value: unknown): ProjectBindingsConfig {
  if (!isRecord(value)) throw new UserError("project bindings must be a mapping");
  const projectInput = value.projects ?? {};
  if (!isRecord(projectInput)) throw new UserError("project bindings.projects must be a mapping");
  const projects: ProjectBindingsConfig["projects"] = {};
  for (const [id, candidate] of Object.entries(projectInput)) {
    if (id.trim() === "" || !isRecord(candidate)) throw new UserError(`project binding ${id || "<empty>"} must be a mapping`);
    const projectPath = requiredString(candidate.path, `project binding ${id}.path`);
    if (!path.isAbsolute(projectPath)) throw new UserError(`project binding ${id}.path must be absolute`);
    projects[id] = { path: path.resolve(projectPath) };
  }
  return { projects };
}

export function validateLock(value: unknown): LockConfig {
  if (!isRecord(value)) throw new UserError("lock file must be a mapping");
  const sourceInput = value.sources ?? {};
  if (!isRecord(sourceInput)) throw new UserError("lock.sources must be a mapping");
  const sources: LockConfig["sources"] = {};
  for (const [id, candidate] of Object.entries(sourceInput)) {
    if (!isRecord(candidate)) throw new UserError(`lock source ${id} must be a mapping`);
    sources[id] = { commit: requiredString(candidate.commit, `lock source ${id}.commit`) };
  }
  return { sources };
}
