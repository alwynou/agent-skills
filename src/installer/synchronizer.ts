import path from "node:path";
import type { AgentAdapter } from "../agents/adapter.js";
import { pathExists, type FsPort } from "../core/fs.js";
import { UserError } from "../core/errors.js";
import type { ManagedLink, ResolvedSkill } from "../core/types.js";
import type { RegistryStore } from "../registry/store.js";

export interface SyncResult {
  created: string[];
  removed: string[];
  unchanged: string[];
  skipped: string[];
}

async function isExpectedLink(fs: FsPort, link: ManagedLink): Promise<boolean> {
  try {
    const stat = await fs.lstat(link.linkPath);
    if (!stat.isSymbolicLink()) return false;
    const rawTarget = await fs.readlink(link.linkPath);
    return path.resolve(path.dirname(link.linkPath), rawTarget) === path.resolve(link.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class Synchronizer {
  constructor(
    private readonly fs: FsPort,
    private readonly store: RegistryStore,
    private readonly adapters: AgentAdapter[],
  ) {}

  async desiredLinks(skills: ResolvedSkill[]): Promise<ManagedLink[]> {
    const adapters = new Map(this.adapters.map((adapter) => [adapter.id, adapter]));
    const desired: ManagedLink[] = [];
    for (const skill of skills.filter((candidate) => candidate.enabled)) {
      if (!(await pathExists(this.fs, path.join(skill.absolutePath, "SKILL.md")))) {
        throw new UserError(`skill ${skill.name} is missing SKILL.md at ${skill.absolutePath}`);
      }
      for (const agent of skill.agents) {
        const adapter = adapters.get(agent);
        if (!adapter) throw new UserError(`no adapter registered for ${agent}`);
        desired.push({
          agent,
          skill: skill.name,
          linkPath: await adapter.linkPath(skill),
          targetPath: skill.absolutePath,
        });
      }
    }
    return desired;
  }

  async sync(skills: ResolvedSkill[]): Promise<SyncResult> {
    const desired = await this.desiredLinks(skills);
    const previous = await this.store.readManagedLinks();
    const desiredByPath = new Map(desired.map((link) => [link.linkPath, link]));
    const result: SyncResult = { created: [], removed: [], unchanged: [], skipped: [] };

    for (const oldLink of previous.links) {
      if (desiredByPath.has(oldLink.linkPath)) continue;
      if (await isExpectedLink(this.fs, oldLink)) {
        await this.fs.unlink(oldLink.linkPath);
        result.removed.push(oldLink.linkPath);
      } else {
        result.skipped.push(`${oldLink.linkPath} (no longer the managed symlink)`);
      }
    }

    const recorded: ManagedLink[] = [];
    for (const link of desired) {
      await this.fs.mkdir(path.dirname(link.linkPath));
      if (await pathExists(this.fs, link.linkPath)) {
        if (await isExpectedLink(this.fs, link)) {
          result.unchanged.push(link.linkPath);
          recorded.push(link);
          continue;
        }
        result.skipped.push(`${link.linkPath} (occupied by user content or another link)`);
        continue;
      }
      await this.fs.symlink(link.targetPath, link.linkPath);
      result.created.push(link.linkPath);
      recorded.push(link);
    }

    await this.store.writeManagedLinks({ version: 1, links: recorded });
    return result;
  }
}
