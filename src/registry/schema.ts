import { agentIds, type LockConfig, type RegistryConfig } from "../core/types.js";
import { UserError } from "../core/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserError(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateRegistry(value: unknown): RegistryConfig {
  if (!isRecord(value)) throw new UserError("registry must be a mapping");
  const sourceInput = value.sources ?? {};
  const skillInput = value.skills ?? {};
  if (!isRecord(sourceInput)) throw new UserError("registry.sources must be a mapping");
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

  const skills: RegistryConfig["skills"] = {};
  for (const [name, candidate] of Object.entries(skillInput)) {
    if (!isRecord(candidate)) throw new UserError(`skill ${name} must be a mapping`);
    const source = requiredString(candidate.source, `skill ${name}.source`);
    if (source !== "local" && !(source in sources)) {
      throw new UserError(`skill ${name} references unknown source ${source}`);
    }
    if (typeof candidate.enabled !== "boolean") {
      throw new UserError(`skill ${name}.enabled must be a boolean`);
    }
    if (!Array.isArray(candidate.agents) || candidate.agents.length === 0) {
      throw new UserError(`skill ${name}.agents must be a non-empty list`);
    }
    const agents = candidate.agents.map((agent) => {
      if (agent === "*" || (typeof agent === "string" && agentIds.includes(agent as never))) {
        return agent as "*" | (typeof agentIds)[number];
      }
      throw new UserError(`skill ${name} has unsupported agent ${String(agent)}`);
    });
    skills[name] = {
      source,
      path: requiredString(candidate.path, `skill ${name}.path`),
      enabled: candidate.enabled,
      agents,
    };
  }
  return { sources, skills };
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
