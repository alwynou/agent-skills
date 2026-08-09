import { agentIds, type AgentId, type LockConfig, type RegistryConfig, type SkillTargetConfig } from "../core/types.js";
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
  const projectInput = value.projects ?? {};
  const skillInput = value.skills ?? {};
  if (!isRecord(sourceInput)) throw new UserError("registry.sources must be a mapping");
  if (!isRecord(projectInput)) throw new UserError("registry.projects must be a mapping");
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

  const projects: RegistryConfig["projects"] = {};
  for (const [id, candidate] of Object.entries(projectInput)) {
    if (id.trim() === "" || !isRecord(candidate)) throw new UserError(`project ${id || "<empty>"} must be a mapping`);
    projects[id] = { path: requiredString(candidate.path, `project ${id}.path`) };
  }

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
    const hasAgents = candidate.agents !== undefined;
    const hasTargets = candidate.targets !== undefined;
    if (hasAgents === hasTargets) {
      throw new UserError(`skill ${name} must define exactly one of agents or targets`);
    }

    let agents: Array<AgentId | "*"> | undefined;
    let targets: SkillTargetConfig[] | undefined;
    if (hasAgents) {
      agents = validateAgents(candidate.agents, `skill ${name}.agents`);
    } else {
      if (!Array.isArray(candidate.targets) || candidate.targets.length === 0) {
        throw new UserError(`skill ${name}.targets must be a non-empty list`);
      }
      targets = candidate.targets.map((target, index) => {
        const label = `skill ${name}.targets[${index}]`;
        if (!isRecord(target)) throw new UserError(`${label} must be a mapping`);
        const targetAgents = validateAgents(target.agents, `${label}.agents`);
        if (target.scope === "global") {
          if (target.project !== undefined) throw new UserError(`${label}.project is not allowed for global scope`);
          return { scope: "global", agents: targetAgents };
        }
        if (target.scope === "project") {
          const project = requiredString(target.project, `${label}.project`);
          if (!(project in projects)) throw new UserError(`${label} references unknown project ${project}`);
          return { scope: "project", project, agents: targetAgents };
        }
        throw new UserError(`${label}.scope must be global or project`);
      });
    }
    skills[name] = {
      source,
      path: requiredString(candidate.path, `skill ${name}.path`),
      enabled: candidate.enabled,
      ...(agents ? { agents } : {}),
      ...(targets ? { targets } : {}),
    };
  }
  return { sources, projects, skills };
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
