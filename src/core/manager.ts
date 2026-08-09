import path from "node:path";
import { builtInAdapters, type AgentAdapter } from "../agents/adapter.js";
import type { FsPort } from "./fs.js";
import { pathExists } from "./fs.js";
import type { Diagnostic, RegistryConfig, ResolvedProject, ResolvedSkill, UpdateInfo } from "./types.js";
import type { ProjectPaths } from "./paths.js";
import type { RegistryStore } from "../registry/store.js";
import { resolveProjects, resolveSkills } from "../registry/resolve.js";
import type { GitPort } from "../git/client.js";
import { GitSource } from "../sources/git-source.js";
import { Synchronizer, type SyncResult } from "../installer/synchronizer.js";
import { ProjectExcluder } from "../installer/project-excluder.js";
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
    return resolveSkills(await this.store.readRegistry(), this.paths, await this.store.readProjectBindings());
  }

  async listProjects(): Promise<ResolvedProject[]> {
    return resolveProjects(await this.store.readRegistry(), await this.store.readProjectBindings());
  }

  async bindProject(projectId: string, projectPath: string): Promise<string> {
    const registry = await this.store.readRegistry();
    if (!registry.projects.includes(projectId)) throw new UserError(`unknown project ${projectId}`);
    const root = path.resolve(projectPath);
    if (root === path.parse(root).root) throw new UserError(`project ${projectId}.path cannot be a filesystem root`);
    if (!(await pathExists(this.fs, root))) throw new UserError(`project ${projectId} does not exist at ${root}`);
    if (!(await this.fs.lstat(root)).isDirectory()) throw new UserError(`project ${projectId} is not a directory: ${root}`);
    const bindings = await this.store.readProjectBindings();
    bindings.projects[projectId] = { path: root };
    resolveProjects(registry, bindings);
    await this.store.writeProjectBindings(bindings);
    return root;
  }

  async unbindProject(projectId: string): Promise<void> {
    const registry = await this.store.readRegistry();
    if (!registry.projects.includes(projectId)) throw new UserError(`unknown project ${projectId}`);
    const bindings = await this.store.readProjectBindings();
    if (!bindings.projects[projectId]) throw new UserError(`project ${projectId} is not bound on this device`);
    const managed = await this.store.readManagedLinks();
    if (managed.links.some((link) => link.scope === "project" && link.projectId === projectId)) {
      throw new UserError(`project ${projectId} still has managed links; disable or remove its targets, run sync, then unbind`);
    }
    delete bindings.projects[projectId];
    await this.store.writeProjectBindings(bindings);
  }

  async sync(): Promise<SyncResult> {
    return new Synchronizer(this.fs, this.store, this.adapters, this.git).sync(await this.list());
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
    let projects: ResolvedProject[];
    let skills: ResolvedSkill[];
    try {
      const bindings = await this.store.readProjectBindings();
      projects = resolveProjects(registry, bindings);
      skills = resolveSkills(registry, this.paths, bindings);
      diagnostics.push({ level: "ok", message: "local project bindings are valid" });
    } catch (error) {
      diagnostics.push({ level: "error", message: `local project bindings are invalid: ${(error as Error).message}` });
      return diagnostics;
    }
    for (const project of projects) {
      if (!project.root) {
        diagnostics.push({ level: "error", message: `${project.id}: project is not bound on this device` });
        continue;
      }
      if (!(await pathExists(this.fs, project.root))) {
        diagnostics.push({ level: "error", message: `${project.id}: bound path does not exist: ${project.root}` });
        continue;
      }
      diagnostics.push(
        (await this.fs.lstat(project.root)).isDirectory()
          ? { level: "ok", message: `${project.id}: bound to ${project.root}` }
          : { level: "error", message: `${project.id}: bound path is not a directory: ${project.root}` },
      );
    }
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

    let desired;
    try {
      desired = await new Synchronizer(this.fs, this.store, this.adapters, this.git).desiredLinks(skills);
    } catch (error) {
      diagnostics.push({ level: "error", message: (error as Error).message });
      return diagnostics;
    }
    const correctProjectLinks = [];
    for (const link of desired) {
      const label =
        link.scope === "project" ? `${link.agent}/${link.projectId}/${link.skill}` : `${link.agent}/${link.skill}`;
      if (!(await pathExists(this.fs, link.linkPath))) {
        diagnostics.push({ level: "warning", message: `${label}: link is missing` });
      } else {
        const stat = await this.fs.lstat(link.linkPath);
        if (!stat.isSymbolicLink()) {
          diagnostics.push({ level: "error", message: `${link.linkPath}: occupied by non-symlink content` });
        } else {
          const target = path.resolve(path.dirname(link.linkPath), await this.fs.readlink(link.linkPath));
          diagnostics.push(
            target === path.resolve(link.targetPath)
              ? { level: "ok", message: `${label}: link is correct` }
              : { level: "error", message: `${label}: link points elsewhere` },
          );
          if (link.scope === "project" && target === path.resolve(link.targetPath)) correctProjectLinks.push(link);
        }
      }
    }
    for (const issue of await new ProjectExcluder(this.fs, this.git).diagnose(correctProjectLinks)) {
      diagnostics.push({ level: "error", message: issue });
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
