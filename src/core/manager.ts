import path from "node:path";
import { builtInAdapters, type AgentAdapter } from "../agents/adapter.js";
import type { FsPort } from "./fs.js";
import { pathExists } from "./fs.js";
import type { Diagnostic, InstallSkillPlan, InstallSkillRequest, RegistryConfig, ResolvedProject, ResolvedSkill, SkillTargetConfig, UpdateInfo } from "./types.js";
import type { ProjectPaths } from "./paths.js";
import type { RegistryStore } from "../registry/store.js";
import { resolveProjects, resolveSkills } from "../registry/resolve.js";
import type { GitPort } from "../git/client.js";
import { GitSource } from "../sources/git-source.js";
import { Synchronizer, type SyncResult } from "../installer/synchronizer.js";
import { ProjectExcluder } from "../installer/project-excluder.js";
import { UserError } from "./errors.js";
import { GitImporter } from "../sources/git-importer.js";
import { validateRegistry } from "../registry/schema.js";

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

  async sync(skillName?: string): Promise<SyncResult> {
    return new Synchronizer(this.fs, this.store, this.adapters, this.git).sync(
      await this.list(),
      skillName ? new Set([skillName]) : undefined,
    );
  }

  async install(request: InstallSkillRequest): Promise<InstallSkillPlan> {
    const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!identifierPattern.test(request.skillName)) throw new UserError("skill name must use lowercase letters, numbers, and single hyphens");
    if (request.sourceId && !identifierPattern.test(request.sourceId)) throw new UserError("source ID must use lowercase letters, numbers, and single hyphens");
    if (request.projectId && !identifierPattern.test(request.projectId)) throw new UserError("project ID must use lowercase letters, numbers, and single hyphens");
    const registry = structuredClone(await this.store.readRegistry());
    const lock = structuredClone(await this.store.readLock());
    const bindings = structuredClone(await this.store.readProjectBindings());
    const existingSkill = registry.skills[request.skillName];
    let sourceId: string;
    let skillPath: string;
    let repo: string | null = null;
    let commit: string | null = null;
    let sourceAdded = false;

    if (existingSkill) {
      if (request.ref) throw new UserError("--ref is only allowed when adding a new source");
      sourceId = existingSkill.source;
      skillPath = existingSkill.path;
      if (request.sourceId && request.sourceId !== sourceId) throw new UserError(`skill ${request.skillName} already uses source ${sourceId}`);
      if (request.skillPath && request.skillPath !== skillPath) throw new UserError(`skill ${request.skillName} already uses path ${skillPath}`);
      if (sourceId !== "local") {
        repo = registry.sources[sourceId]?.repo ?? null;
        if (request.repo && request.repo !== repo) throw new UserError(`source ${sourceId} already uses repository ${repo}`);
        commit = lock.sources[sourceId]?.commit ?? null;
      }
    } else {
      sourceId = request.sourceId ?? "";
      skillPath = request.skillPath ?? "";
      if (!sourceId) throw new UserError("installing a new skill requires --source-id");
      if (!skillPath) throw new UserError("installing a new skill requires --path");
      const existingSource = registry.sources[sourceId];
      if (existingSource) {
        if (request.ref) throw new UserError("--ref is only allowed when adding a new source");
        repo = existingSource.repo;
        if (request.repo && request.repo !== repo) throw new UserError(`source ${sourceId} already uses repository ${repo}`);
        commit = lock.sources[sourceId]?.commit ?? null;
      } else {
        if (!request.repo) throw new UserError("installing a new source requires --repo");
        repo = request.repo;
        const vendorPath = path.join(this.paths.vendors, sourceId);
        if (await pathExists(this.fs, vendorPath)) throw new UserError(`${vendorPath}: source path is already occupied`);
        commit = (await new GitImporter(this.git).inspect(repo, request.ref, skillPath)).commit;
        registry.sources[sourceId] = { type: "git", repo };
        lock.sources[sourceId] = { commit };
        sourceAdded = true;
      }
      if (!sourceAdded) {
        const skillFile = path.join(this.paths.vendors, registry.sources[sourceId]?.path ?? sourceId, skillPath, "SKILL.md");
        if (!(await pathExists(this.fs, skillFile))) throw new UserError(`source is missing ${skillPath}/SKILL.md`);
      }
    }

    let projectBinding: InstallSkillPlan["projectBinding"] = null;
    let target: SkillTargetConfig;
    if (request.scope === "project") {
      if (!request.projectId || !request.projectPath) throw new UserError("project scope requires --project and --project-path");
      const projectRoot = path.resolve(request.projectPath);
      if (projectRoot === path.parse(projectRoot).root) throw new UserError("project path cannot be a filesystem root");
      if (!(await pathExists(this.fs, projectRoot)) || !(await this.fs.lstat(projectRoot)).isDirectory()) {
        throw new UserError(`project is not a directory: ${projectRoot}`);
      }
      if (!registry.projects.includes(request.projectId)) registry.projects.push(request.projectId);
      const currentBinding = bindings.projects[request.projectId];
      if (currentBinding && path.resolve(currentBinding.path) !== projectRoot) {
        throw new UserError(`project ${request.projectId} is already bound to ${currentBinding.path}`);
      }
      const otherBinding = Object.entries(bindings.projects).find(([id, value]) => id !== request.projectId && path.resolve(value.path) === projectRoot);
      if (otherBinding) throw new UserError(`project path is already bound to ${otherBinding[0]}`);
      bindings.projects[request.projectId] = { path: projectRoot };
      projectBinding = { id: request.projectId, path: projectRoot };
      target = { scope: "project", project: request.projectId, agents: request.agents };
    } else {
      if (request.projectId || request.projectPath) throw new UserError("project options are not allowed for global scope");
      target = { scope: "global", agents: request.agents };
    }

    const trackedChanges = new Set<string>();
    const localChanges = new Set<string>();
    if (sourceAdded) {
      trackedChanges.add(".gitmodules");
      trackedChanges.add(path.join("vendors", sourceId));
      trackedChanges.add(path.relative(this.paths.root, this.paths.lock));
    }
    const skill = existingSkill ?? { source: sourceId, path: skillPath, enabled: true, targets: [] };
    if (!existingSkill) registry.skills[request.skillName] = skill;
    const matchingTarget = skill.targets.find((candidate) =>
      candidate.scope === target.scope && (candidate.scope === "global" || candidate.project === (target as typeof candidate).project),
    );
    if (matchingTarget) {
      const mergedAgents = matchingTarget.agents.includes("*") || target.agents.includes("*")
        ? ["*" as const]
        : [...new Set([...matchingTarget.agents, ...target.agents])];
      if (JSON.stringify(mergedAgents) !== JSON.stringify(matchingTarget.agents)) matchingTarget.agents = mergedAgents;
    } else {
      skill.targets.push(target);
    }
    if (!skill.enabled) skill.enabled = true;

    const originalRegistry = await this.store.readRegistry();
    if (JSON.stringify(registry) !== JSON.stringify(originalRegistry)) trackedChanges.add(path.relative(this.paths.root, this.paths.registry));
    const originalBindings = await this.store.readProjectBindings();
    if (JSON.stringify(bindings) !== JSON.stringify(originalBindings)) localChanges.add(path.relative(this.paths.root, this.paths.projectBindings));
    validateRegistry(registry);
    resolveProjects(registry, bindings);

    const resolvedTarget = request.scope === "global"
      ? { scope: "global" as const, agents: request.agents.includes("*") ? this.adapters.map((adapter) => adapter.id) : request.agents.filter((agent) => agent !== "*") }
      : { scope: "project" as const, projectId: request.projectId as string, projectRoot: projectBinding?.path ?? null, agents: request.agents.includes("*") ? this.adapters.map((adapter) => adapter.id) : request.agents.filter((agent) => agent !== "*") };
    const fakeSkill: ResolvedSkill = { name: request.skillName, sourceId, absolutePath: "", enabled: true, targets: [resolvedTarget] };
    const links = await Promise.all(resolvedTarget.agents.map(async (agent) => {
      const adapter = this.adapters.find((candidate) => candidate.id === agent);
      if (!adapter) throw new UserError(`no adapter registered for ${agent}`);
      return adapter.linkPath(fakeSkill, resolvedTarget);
    }));

    if (!request.dryRun) {
      if (sourceAdded) {
        await new GitImporter(this.git).addSubmodule(
          this.paths.root,
          sourceId,
          repo as string,
          path.join("vendors", sourceId),
          commit as string,
        );
      }
      await this.store.writeRegistry(registry);
      if (sourceAdded) await this.store.writeLock(lock);
      if (localChanges.size > 0) await this.store.writeProjectBindings(bindings);
      if (request.sync) await this.sync(request.skillName);
    }

    return {
      skill: request.skillName,
      source: { id: sourceId, repo, commit, added: sourceAdded },
      skillPath,
      target,
      projectBinding,
      trackedChanges: [...trackedChanges],
      localChanges: [...localChanges],
      links,
      applied: !request.dryRun,
    };
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
