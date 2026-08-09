import path from "node:path";
import YAML from "yaml";
import { atomicWrite, pathExists, type FsPort } from "../core/fs.js";
import type { LockConfig, ManagedLinksFile, ProjectBindingsConfig, RegistryConfig } from "../core/types.js";
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
    if (!(await pathExists(this.fs, this.paths.managedLinks))) return { version: 2, links: [] };
    const parsed = JSON.parse(await this.fs.readFile(this.paths.managedLinks)) as Partial<ManagedLinksFile>;
    if (!Array.isArray(parsed.links)) throw new Error("unsupported managed-links file");
    if (parsed.version !== 2 || parsed.links.some((link) => link.scope !== "global" && link.scope !== "project")) {
      throw new Error("unsupported managed-links file");
    }
    return { version: 2, links: parsed.links as ManagedLinksFile["links"] };
  }

  async writeManagedLinks(value: ManagedLinksFile): Promise<void> {
    await this.fs.mkdir(path.dirname(this.paths.managedLinks));
    await atomicWrite(this.fs, this.paths.managedLinks, `${JSON.stringify(value, null, 2)}\n`);
  }
}
