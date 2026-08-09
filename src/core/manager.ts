import path from "node:path";
import { builtInAdapters, type AgentAdapter } from "../agents/adapter.js";
import type { FsPort } from "./fs.js";
import { pathExists } from "./fs.js";
import type { Diagnostic, RegistryConfig, ResolvedSkill, UpdateInfo } from "./types.js";
import type { ProjectPaths } from "./paths.js";
import type { RegistryStore } from "../registry/store.js";
import { resolveSkills } from "../registry/resolve.js";
import type { GitPort } from "../git/client.js";
import { GitSource } from "../sources/git-source.js";
import { Synchronizer, type SyncResult } from "../installer/synchronizer.js";
import { UserError } from "./errors.js";

export class SkillManager {
  private readonly adapters: AgentAdapter[];

  constructor(
    private readonly fs: FsPort,
    private readonly git: GitPort,
    private readonly store: RegistryStore,
    private readonly paths: ProjectPaths,
    home: string,
    adapters?: AgentAdapter[],
  ) {
    this.adapters = adapters ?? builtInAdapters(home);
  }

  async list(): Promise<ResolvedSkill[]> {
    return resolveSkills(await this.store.readRegistry(), this.paths);
  }

  async sync(): Promise<SyncResult> {
    return new Synchronizer(this.fs, this.store, this.adapters).sync(await this.list());
  }

  async doctor(): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    let registry: RegistryConfig;
    try {
      registry = await this.store.readRegistry();
      diagnostics.push({ level: "ok", message: "registry is valid" });
    } catch (error) {
      return [{ level: "error", message: `registry is invalid: ${(error as Error).message}` }];
    }

    const lock = await this.store.readLock();
    diagnostics.push({ level: "ok", message: "lock file is valid" });
    const skills = resolveSkills(registry, this.paths);
    for (const skill of skills) {
      const skillFile = path.join(skill.absolutePath, "SKILL.md");
      diagnostics.push(
        (await pathExists(this.fs, skillFile))
          ? { level: "ok", message: `${skill.name}: SKILL.md exists` }
          : { level: "error", message: `${skill.name}: missing ${skillFile}` },
      );
    }

    for (const [id, config] of Object.entries(registry.sources)) {
      const source = new GitSource(id, config, this.paths.vendors, this.git);
      try {
        const current = await source.currentCommit();
        const locked = lock.sources[id]?.commit;
        diagnostics.push(
          locked === current
            ? { level: "ok", message: `${id}: source commit matches lock` }
            : { level: "warning", message: `${id}: current ${current.slice(0, 8)} differs from lock ${locked?.slice(0, 8) ?? "missing"}` },
        );
      } catch (error) {
        diagnostics.push({ level: "error", message: `${id}: ${(error as Error).message}` });
      }
    }

    const desired = await new Synchronizer(this.fs, this.store, this.adapters).desiredLinks(skills).catch(() => []);
    for (const link of desired) {
      if (!(await pathExists(this.fs, link.linkPath))) {
        diagnostics.push({ level: "warning", message: `${link.agent}/${link.skill}: link is missing` });
      } else {
        const stat = await this.fs.lstat(link.linkPath);
        if (!stat.isSymbolicLink()) {
          diagnostics.push({ level: "error", message: `${link.linkPath}: occupied by non-symlink content` });
        } else {
          const target = path.resolve(path.dirname(link.linkPath), await this.fs.readlink(link.linkPath));
          diagnostics.push(
            target === path.resolve(link.targetPath)
              ? { level: "ok", message: `${link.agent}/${link.skill}: link is correct` }
              : { level: "error", message: `${link.agent}/${link.skill}: link points elsewhere` },
          );
        }
      }
    }
    return diagnostics;
  }

  async check(sourceId?: string): Promise<UpdateInfo[]> {
    const registry = await this.store.readRegistry();
    const lock = await this.store.readLock();
    const ids = sourceId ? [sourceId] : Object.keys(registry.sources);
    return Promise.all(
      ids.map((id) => {
        const config = registry.sources[id];
        if (!config) throw new UserError(`unknown source ${id}`);
        return new GitSource(id, config, this.paths.vendors, this.git).check(lock.sources[id]?.commit ?? null);
      }),
    );
  }

  async diff(sourceId: string): Promise<string> {
    const registry = await this.store.readRegistry();
    const lock = await this.store.readLock();
    const config = registry.sources[sourceId];
    if (!config) throw new UserError(`unknown source ${sourceId}`);
    const locked = lock.sources[sourceId]?.commit;
    if (!locked) throw new UserError(`source ${sourceId} has no locked commit`);
    const source = new GitSource(sourceId, config, this.paths.vendors, this.git);
    const candidate = await source.fetchCandidate();
    const paths = Object.values(registry.skills)
      .filter((skill) => skill.source === sourceId)
      .map((skill) => skill.path);
    return source.diff(locked, candidate, paths.length > 0 ? paths : ["."]);
  }

  async update(sourceId: string): Promise<UpdateInfo> {
    const registry = await this.store.readRegistry();
    const lock = await this.store.readLock();
    const config = registry.sources[sourceId];
    if (!config) throw new UserError(`unknown source ${sourceId}`);
    const source = new GitSource(sourceId, config, this.paths.vendors, this.git);
    const info = await source.check(lock.sources[sourceId]?.commit ?? null);
    await source.update(info.candidate);
    lock.sources[sourceId] = { commit: info.candidate };
    await this.store.writeLock(lock);
    await this.sync();
    return info;
  }

  async setEnabled(skillName: string, enabled: boolean): Promise<void> {
    const registry = await this.store.readRegistry();
    const skill = registry.skills[skillName];
    if (!skill) throw new UserError(`unknown skill ${skillName}`);
    skill.enabled = enabled;
    await this.store.writeRegistry(registry);
  }
}
