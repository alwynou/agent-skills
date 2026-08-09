import path from "node:path";
import YAML from "yaml";
import { atomicWrite, type FsPort } from "../core/fs.js";
import type { LockConfig, ManagedLinksFile, RegistryConfig } from "../core/types.js";
import { validateLock, validateRegistry } from "./schema.js";
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

  async readLock(): Promise<LockConfig> {
    return validateLock(YAML.parse(await this.fs.readFile(this.paths.lock)));
  }

  async writeLock(lock: LockConfig): Promise<void> {
    await atomicWrite(this.fs, this.paths.lock, YAML.stringify(lock));
  }

  async readManagedLinks(): Promise<ManagedLinksFile> {
    const parsed = JSON.parse(await this.fs.readFile(this.paths.managedLinks)) as ManagedLinksFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.links)) {
      throw new Error("unsupported managed-links file");
    }
    return parsed;
  }

  async writeManagedLinks(value: ManagedLinksFile): Promise<void> {
    await this.fs.mkdir(path.dirname(this.paths.managedLinks));
    await atomicWrite(this.fs, this.paths.managedLinks, `${JSON.stringify(value, null, 2)}\n`);
  }
}
