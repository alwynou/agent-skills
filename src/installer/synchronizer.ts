import path from "node:path";
import type { AgentAdapter } from "../agents/adapter.js";
import { pathExists, type FsPort } from "../core/fs.js";
import { UserError } from "../core/errors.js";
import type { ManagedLink, ResolvedSkill } from "../core/types.js";
import type { RegistryStore } from "../registry/store.js";
import type { GitPort } from "../git/client.js";
import { ProjectExcluder } from "./project-excluder.js";

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
    private readonly git: GitPort,
  ) {}

  async desiredLinks(skills: ResolvedSkill[]): Promise<ManagedLink[]> {
    const adapters = new Map(this.adapters.map((adapter) => [adapter.id, adapter]));
    const desired: ManagedLink[] = [];
    for (const skill of skills.filter((candidate) => candidate.enabled)) {
      if (!(await pathExists(this.fs, path.join(skill.absolutePath, "SKILL.md")))) {
        throw new UserError(`skill ${skill.name} is missing SKILL.md at ${skill.absolutePath}`);
      }
      for (const target of skill.targets) {
        let projectRoot: string | undefined;
        if (target.scope === "project") {
          if (!target.projectRoot) throw new UserError(`project ${target.projectId} is not bound on this device`);
          projectRoot = target.projectRoot;
          if (!(await pathExists(this.fs, target.projectRoot)))
            throw new UserError(`project ${target.projectId} does not exist at ${target.projectRoot}`);
          const stat = await this.fs.lstat(target.projectRoot);
          if (!stat.isDirectory()) throw new UserError(`project ${target.projectId} is not a directory: ${target.projectRoot}`);
        }
        for (const agent of target.agents) {
          const adapter = adapters.get(agent);
          if (!adapter) throw new UserError(`no adapter registered for ${agent}`);
          desired.push({
            agents: [agent],
            skill: skill.name,
            scope: target.scope,
            ...(target.scope === "project"
              ? { projectId: target.projectId, projectRoot: projectRoot as string }
              : {}),
            linkPath: await adapter.linkPath(skill, target),
            targetPath: skill.absolutePath,
          });
        }
      }
    }
    const unique = new Map<string, ManagedLink>();
    for (const link of desired) {
      const existing = unique.get(link.linkPath);
      if (!existing) {
        unique.set(link.linkPath, link);
        continue;
      }
      if (existing.targetPath !== link.targetPath || existing.scope !== link.scope || existing.projectId !== link.projectId) {
        throw new UserError(`${link.linkPath}: multiple skill targets resolve to the same link path`);
      }
      existing.agents = [...new Set([...existing.agents, ...link.agents])];
    }
    return [...unique.values()];
  }

  async sync(skills: ResolvedSkill[], selectedSkills?: ReadonlySet<string>, allowMissing = false): Promise<SyncResult> {
    const selected = selectedSkills ? skills.filter((skill) => selectedSkills.has(skill.name)) : skills;
    if (selectedSkills && selected.length !== selectedSkills.size && !allowMissing) {
      const found = new Set(selected.map((skill) => skill.name));
      const missing = [...selectedSkills].filter((name) => !found.has(name));
      throw new UserError(`unknown skill ${missing.join(", ")}`);
    }
    const desired = await this.desiredLinks(selected);
    const previous = await this.store.readManagedLinks();
    const untouched = selectedSkills ? previous.links.filter((link) => !selectedSkills.has(link.skill)) : [];
    const previousSelected = selectedSkills ? previous.links.filter((link) => selectedSkills.has(link.skill)) : previous.links;
    const desiredByPath = new Map(desired.map((link) => [link.linkPath, link]));
    const result: SyncResult = { created: [], removed: [], unchanged: [], skipped: [] };

    const installable: ManagedLink[] = [];
    for (const link of desired) {
      if (!(await pathExists(this.fs, link.linkPath)) || (await isExpectedLink(this.fs, link))) {
        installable.push(link);
      }
    }
    const applyExcludes = await new ProjectExcluder(this.fs, this.git).prepare([...untouched, ...installable], previous.links);

    for (const oldLink of previousSelected) {
      if (desiredByPath.has(oldLink.linkPath)) continue;
      if (await isExpectedLink(this.fs, oldLink)) {
        await this.fs.unlink(oldLink.linkPath);
        result.removed.push(oldLink.linkPath);
      } else {
        result.skipped.push(`${oldLink.linkPath} (no longer the managed symlink)`);
      }
    }

    const recorded: ManagedLink[] = [...untouched];
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

    await applyExcludes();
    await this.store.writeManagedLinks({ version: 3, links: recorded });
    return result;
  }
}
