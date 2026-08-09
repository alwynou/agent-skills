import path from "node:path";
import YAML from "yaml";
import { atomicWrite, pathExists, type FsPort } from "../core/fs.js";
import { agentIds, type AgentId, type LockConfig, type ManagedLink, type ManagedLinksFile, type ProjectBindingsConfig, type RegistryConfig } from "../core/types.js";
import { validateLock, validateProjectBindings, validateRegistry } from "./schema.js";
import type { ProjectPaths } from "../core/paths.js";

export class RegistryStore {
  constructor(
    private readonly fs: FsPort,
    private readonly paths: ProjectPaths,
  ) {}

  async readRegistry(): Promise<RegistryConfig> {
    return validateRegistry(YAML.parse(await this.fs.readFile(this.paths.registry)));
  }

  async writeRegistry(registry: RegistryConfig): Promise<void> {
    await atomicWrite(this.fs, this.paths.registry, YAML.stringify(registry));
  }

  async readProjectBindings(): Promise<ProjectBindingsConfig> {
    if (!(await pathExists(this.fs, this.paths.projectBindings))) return { projects: {} };
    return validateProjectBindings(YAML.parse(await this.fs.readFile(this.paths.projectBindings)));
  }

  async writeProjectBindings(bindings: ProjectBindingsConfig): Promise<void> {
    await this.fs.mkdir(path.dirname(this.paths.projectBindings));
    await atomicWrite(this.fs, this.paths.projectBindings, YAML.stringify(bindings));
  }

  async readLock(): Promise<LockConfig> {
    return validateLock(YAML.parse(await this.fs.readFile(this.paths.lock)));
  }

  async writeLock(lock: LockConfig): Promise<void> {
    await atomicWrite(this.fs, this.paths.lock, YAML.stringify(lock));
  }

  async readManagedLinks(): Promise<ManagedLinksFile> {
    if (!(await pathExists(this.fs, this.paths.managedLinks))) return { version: 3, links: [] };
    const parsed = JSON.parse(await this.fs.readFile(this.paths.managedLinks)) as { version?: number; links?: unknown[] };
    if (!Array.isArray(parsed.links)) throw new Error("unsupported managed-links file");
    if (![2, 3].includes(parsed.version ?? 0)) throw new Error("unsupported managed-links file");
    const links = parsed.links.map((value): ManagedLink => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("unsupported managed-links file");
      const link = value as Record<string, unknown>;
      if (link.scope !== "global" && link.scope !== "project") throw new Error("unsupported managed-links file");
      const agents = parsed.version === 2 ? [link.agent] : link.agents;
      if (!Array.isArray(agents) || agents.length === 0 || agents.some((agent) => !agentIds.includes(agent as AgentId))) {
        throw new Error("unsupported managed-links file");
      }
      for (const field of ["skill", "linkPath", "targetPath"] as const) {
        if (typeof link[field] !== "string" || link[field] === "") throw new Error("unsupported managed-links file");
      }
      if (!path.isAbsolute(link.linkPath as string) || !path.isAbsolute(link.targetPath as string)) {
        throw new Error("unsupported managed-links file");
      }
      if (link.scope === "project" &&
          (typeof link.projectId !== "string" || typeof link.projectRoot !== "string" || !path.isAbsolute(link.projectRoot))) {
        throw new Error("unsupported managed-links file");
      }
      return {
        agents: [...new Set(agents as AgentId[])],
        skill: link.skill as string,
        scope: link.scope,
        ...(link.scope === "project" ? { projectId: link.projectId as string, projectRoot: link.projectRoot as string } : {}),
        linkPath: link.linkPath as string,
        targetPath: link.targetPath as string,
      };
    });
    return { version: 3, links };
  }

  async writeManagedLinks(value: ManagedLinksFile): Promise<void> {
    await this.fs.mkdir(path.dirname(this.paths.managedLinks));
    await atomicWrite(this.fs, this.paths.managedLinks, `${JSON.stringify(value, null, 2)}\n`);
  }
}
