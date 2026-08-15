import path from "node:path";
import { builtInAdapters, type AgentAdapter } from "../agents/adapter.js";
import type { FsPort } from "./fs.js";
import { pathExists } from "./fs.js";
import { agentIds, type AgentId, type DeleteSkillRequest, type Diagnostic, type InstallSkillPlan, type InstallSkillRequest, type RegistryConfig, type RemoveSkillRequest, type ResolvedProject, type ResolvedSkill, type SetEnabledPlan, type SetEnabledRequest, type InstalledTarget, type ProjectBindingsConfig, type SkillRemovalPlan, type SkillTargetConfig, type UpdateInfo, type UpdateSourcePlan, type UpdateSourceRequest } from "./types.js";
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

/** `"*"` absorbs everything else, so a wildcard on either side wins. */
function mergeAgents(existing: Array<AgentId | "*"> | undefined, incoming: Array<AgentId | "*">): Array<AgentId | "*"> {
  if (!existing) return incoming;
  if (existing.includes("*") || incoming.includes("*")) return ["*"];
  return [...new Set([...existing, ...incoming])];
}
import { describeSkill, type SkillDetail } from "./skill-detail.js";

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

  async show(skillName: string): Promise<SkillDetail> {
    const registry = await this.store.readRegistry();
    const config = registry.skills[skillName];
    const skill = (await this.list()).find((candidate) => candidate.name === skillName);
    if (!config || !skill) throw new UserError(`unknown skill ${skillName}`);
    const lock = await this.store.readLock();
    const external = config.source !== "local";
    return describeSkill(this.fs, skill, {
      repo: external ? registry.sources[config.source]?.repo ?? null : null,
      lockedCommit: external ? lock.sources[config.source]?.commit ?? null : null,
      skillPath: config.path,
    });
  }

  async listProjects(): Promise<ResolvedProject[]> {
    return resolveProjects(await this.store.readProjectBindings());
  }

  /** Adds one more checkout of a logical project on this machine. */
  async bindProject(projectId: string, projectPath: string): Promise<string[]> {
    const root = path.resolve(projectPath);
    if (root === path.parse(root).root) throw new UserError(`project ${projectId} path cannot be a filesystem root`);
    if (!(await pathExists(this.fs, root))) throw new UserError(`project ${projectId} does not exist at ${root}`);
    if (!(await this.fs.lstat(root)).isDirectory()) throw new UserError(`project ${projectId} is not a directory: ${root}`);
    const bindings = await this.store.readProjectBindings();
    const existing = bindings.projects[projectId] ?? { paths: [], skills: {} };
    const paths = existing.paths.includes(root) ? existing.paths : [...existing.paths, root];
    bindings.projects[projectId] = { ...existing, paths };
    resolveProjects(bindings);
    await this.store.writeProjectBindings(bindings);
    return paths;
  }

  /** Drops one checkout, or the whole project when no path is given. */
  async unbindProject(projectId: string, projectPath?: string): Promise<string[]> {
    const bindings = await this.store.readProjectBindings();
    const existing = bindings.projects[projectId];
    if (!existing || existing.paths.length === 0) throw new UserError(`project ${projectId} is not bound on this device`);
    let removing = existing.paths;
    if (projectPath !== undefined) {
      const root = path.resolve(projectPath);
      if (!existing.paths.includes(root)) throw new UserError(`project ${projectId} is not bound to ${root}`);
      removing = [root];
    }
    const managed = await this.store.readManagedLinks();
    if (managed.links.some((link) => link.scope === "project" && link.projectId === projectId && link.projectRoot !== undefined && removing.includes(link.projectRoot))) {
      throw new UserError(`project ${projectId} still has managed links; remove its Skills, run sync, then unbind`);
    }
    const remaining = existing.paths.filter((candidate) => !removing.includes(candidate));
    if (remaining.length === 0) delete bindings.projects[projectId];
    else bindings.projects[projectId] = { ...existing, paths: remaining };
    await this.store.writeProjectBindings(bindings);
    return remaining;
  }

  async sync(skillName?: string): Promise<SyncResult> {
    return new Synchronizer(this.fs, this.store, this.adapters, this.git).sync(
      await this.list(),
      skillName ? new Set([skillName]) : undefined,
    );
  }

  private async reconcileRemoved(registry: RegistryConfig, bindings: ProjectBindingsConfig, skillNames: string[]): Promise<SyncResult> {
    const skills = resolveSkills(registry, this.paths, bindings);
    return new Synchronizer(this.fs, this.store, this.adapters, this.git).sync(
      skills,
      new Set(skillNames),
      true,
    );
  }

  private async managedLinkPaths(skillNames: ReadonlySet<string>, predicate?: (link: Awaited<ReturnType<RegistryStore["readManagedLinks"]>>["links"][number]) => boolean): Promise<string[]> {
    const managed = await this.store.readManagedLinks();
    return managed.links
      .filter((link) => skillNames.has(link.skill) && (!predicate || predicate(link)))
      .map((link) => link.linkPath);
  }

  async remove(request: RemoveSkillRequest): Promise<SkillRemovalPlan> {
    const registry = structuredClone(await this.store.readRegistry());
    const bindings = structuredClone(await this.store.readProjectBindings());
    const skill = registry.skills[request.skillName];
    if (!skill) throw new UserError(`unknown skill ${request.skillName}`);
    if (!request.all && !request.scope) throw new UserError("remove requires --all or --scope global|project");
    if (request.all && (request.scope || request.agents || request.projectId)) {
      throw new UserError("--all cannot be combined with scope, agents, or project");
    }

    let registryChanged = false;
    let bindingsChanged = false;
    let target: SkillRemovalPlan["target"] = "all";
    let linkPredicate: ((link: Awaited<ReturnType<RegistryStore["readManagedLinks"]>>["links"][number]) => boolean) | undefined;

    const dropLocalInstall = (projectId: string): void => {
      const install = bindings.projects[projectId];
      if (!install?.skills[request.skillName]) return;
      delete install.skills[request.skillName];
      bindingsChanged = true;
    };

    if (request.all) {
      registryChanged = skill.targets.length > 0;
      skill.targets = [];
      // `--all` means every installation this machine can see, committed or not.
      for (const projectId of Object.keys(bindings.projects)) dropLocalInstall(projectId);
    } else if (request.scope === "project") {
      if (!request.projectId) throw new UserError("project removal requires --project");
      if (request.agents) throw new UserError("--agents is not allowed for project removal");
      target = { scope: "project", project: request.projectId, agents: ["*"] };
      dropLocalInstall(request.projectId);
      linkPredicate = (link) => link.scope === "project" && link.projectId === request.projectId;
    } else {
      if (!request.agents || request.agents.length === 0) throw new UserError("global removal requires --agents");
      if (request.projectId) throw new UserError("--project is not allowed for global removal");
      const requested = new Set(request.agents.includes("*") ? agentIds : request.agents.filter((agent) => agent !== "*"));
      target = { scope: "global", agents: request.agents };
      const nextTargets: SkillTargetConfig[] = [];
      for (const candidate of skill.targets) {
        const existing = candidate.agents.includes("*") ? [...agentIds] : candidate.agents.filter((agent) => agent !== "*");
        const remaining = existing.filter((agent) => !requested.has(agent));
        if (remaining.length !== existing.length) registryChanged = true;
        if (remaining.length > 0) nextTargets.push({ scope: "global", agents: remaining });
      }
      skill.targets = nextTargets;
      linkPredicate = (link) => link.scope === "global" && link.agents.some((agent) => requested.has(agent));
    }

    if (!registryChanged && !bindingsChanged) {
      return {
        action: "remove", skills: [request.skillName], sourceId: null, target,
        trackedChanges: [], links: [], retainedSource: true, ignoredPaths: [], noOp: true, applied: false, syncResult: null,
      };
    }
    // A Skill installed nowhere this machine knows about is disabled only when the
    // registry itself changed; a purely local removal must not decide for other devices.
    const installedLocally = Object.values(bindings.projects).some((install) => install.skills[request.skillName]);
    if (registryChanged && skill.targets.length === 0 && !installedLocally) skill.enabled = false;
    validateRegistry(registry);
    const links = await this.managedLinkPaths(new Set([request.skillName]), linkPredicate);
    const trackedChanges = registryChanged ? [path.relative(this.paths.root, this.paths.registry)] : [];
    if (request.dryRun) {
      return {
        action: "remove", skills: [request.skillName], sourceId: null, target, trackedChanges, links,
        retainedSource: true, ignoredPaths: [], noOp: false, applied: false, syncResult: null,
      };
    }
    if (registryChanged) await this.store.writeRegistry(registry);
    if (bindingsChanged) await this.store.writeProjectBindings(bindings);
    const syncResult = request.sync ? await this.reconcileRemoved(registry, bindings, [request.skillName]) : null;
    return {
      action: "remove", skills: [request.skillName], sourceId: null, target, trackedChanges, links,
      retainedSource: true, ignoredPaths: [], noOp: false, applied: true, syncResult,
    };
  }

  private async trackedFiles(relativePath: string): Promise<string[]> {
    const output = await this.git.run(this.paths.root, ["ls-files", "--", relativePath]);
    return output ? output.split("\n") : [];
  }

  /**
   * Splits `git status` porcelain output into tracked-or-untracked content and ignored
   * content. Callers weigh the two differently: ignored content inside a local Skill may
   * be the user's own data and always refuses, while ignored content inside a vendor is
   * build output of a re-clonable upstream checkout and is removed with it.
   */
  private async worktreeState(cwd: string, pathspec?: string): Promise<{ blocking: string[]; ignored: string[] }> {
    const args = ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"];
    if (pathspec) args.push("--", pathspec);
    const output = await this.git.run(cwd, args);
    const blocking: string[] = [];
    const ignored: string[] = [];
    for (const raw of output ? output.split("\n") : []) {
      // The status code is one or two characters, and the surrounding runner trims the
      // output, so a leading blank in codes such as " M" cannot be relied upon.
      const line = raw.trim();
      if (!line) continue;
      (line.startsWith("!!") ? ignored : blocking).push(line.slice(line.indexOf(" ") + 1));
    }
    return { blocking, ignored };
  }

  private async preflightLocalSkillDelete(registry: RegistryConfig, skillName: string): Promise<{ relativePath: string; trackedFiles: string[] }> {
    if (skillName === "manage-agent-skills") throw new UserError("manage-agent-skills cannot delete itself");
    const skill = registry.skills[skillName] as NonNullable<RegistryConfig["skills"][string]>;
    const skillsRoot = path.resolve(this.paths.root, "skills");
    const absolutePath = path.resolve(this.paths.root, skill.path);
    if (!absolutePath.startsWith(`${skillsRoot}${path.sep}`)) throw new UserError(`local skill ${skillName} must be inside ${skillsRoot} to be deleted`);
    const stat = await this.fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UserError(`local skill ${skillName} must be a real directory`);
    const shared = Object.entries(registry.skills).find(([name, candidate]) =>
      name !== skillName && candidate.source === "local" && path.resolve(this.paths.root, candidate.path) === absolutePath,
    );
    if (shared) throw new UserError(`local skill path is also used by ${shared[0]}`);
    const relativePath = path.relative(this.paths.root, absolutePath);
    const state = await this.worktreeState(this.paths.root, relativePath);
    if (state.blocking.length > 0) {
      throw new UserError(`local skill ${skillName} has modified or untracked content: ${state.blocking.join(", ")}`);
    }
    if (state.ignored.length > 0) {
      throw new UserError(`local skill ${skillName} has ignored content that deletion would destroy: ${state.ignored.join(", ")}`);
    }
    const trackedFiles = await this.trackedFiles(relativePath);
    if (trackedFiles.length === 0) throw new UserError(`local skill ${skillName} has no tracked files`);
    await this.git.run(this.paths.root, ["rm", "--dry-run", "-r", "--", relativePath]);
    return { relativePath, trackedFiles };
  }

  private async preflightSourceDelete(registry: RegistryConfig, sourceId: string): Promise<{ vendorPath: string; ignoredPaths: string[] }> {
    const source = registry.sources[sourceId];
    if (!source) throw new UserError(`unknown source ${sourceId}`);
    const vendorPath = path.join("vendors", source.path ?? sourceId);
    const absolutePath = path.resolve(this.paths.root, vendorPath);
    if (!absolutePath.startsWith(`${path.resolve(this.paths.vendors)}${path.sep}`)) throw new UserError(`source ${sourceId} escapes vendors`);
    if (!(await pathExists(this.fs, absolutePath))) throw new UserError(`source ${sourceId} vendor is missing: ${absolutePath}`);
    const stage = await this.git.run(this.paths.root, ["ls-files", "--stage", "--", vendorPath]);
    if (!stage.startsWith("160000 ")) throw new UserError(`source ${sourceId} is not a tracked submodule at ${vendorPath}`);
    // An uninitialized submodule has no `.git`, and `git -C` inside it would silently
    // resolve to the central repository and report *its* status instead. There is no
    // local checkout to lose in that state, so only inspect an initialized one.
    const initialized = await pathExists(this.fs, path.join(absolutePath, ".git"));
    const state = initialized ? await this.worktreeState(absolutePath) : { blocking: [], ignored: [] };
    if (state.blocking.length > 0) {
      throw new UserError(`source ${sourceId} vendor has modified or untracked content: ${state.blocking.join(", ")}`);
    }
    await this.git.run(this.paths.root, ["rm", "--dry-run", "--", vendorPath]);
    return { vendorPath, ignoredPaths: state.ignored };
  }

  async delete(request: DeleteSkillRequest): Promise<SkillRemovalPlan> {
    if ((request.skillName ? 1 : 0) + (request.sourceId ? 1 : 0) !== 1) {
      throw new UserError("delete requires exactly one skill name or --source");
    }
    const registry = structuredClone(await this.store.readRegistry());
    const lock = structuredClone(await this.store.readLock());
    let action: SkillRemovalPlan["action"] = "delete";
    let skillNames: string[];
    let sourceId: string | null = request.sourceId ?? null;
    let retainedSource = false;
    let localDelete: { relativePath: string; trackedFiles: string[] } | null = null;
    let sourceDelete: { vendorPath: string; ignoredPaths: string[] } | null = null;

    if (request.sourceId) {
      if (request.sourceId === "local") throw new UserError("local is not a deletable source");
      action = "delete-source";
      skillNames = Object.entries(registry.skills).filter(([, skill]) => skill.source === request.sourceId).map(([name]) => name);
      sourceDelete = await this.preflightSourceDelete(registry, request.sourceId);
      for (const name of skillNames) delete registry.skills[name];
      delete registry.sources[request.sourceId];
      delete lock.sources[request.sourceId];
    } else {
      const skillName = request.skillName as string;
      const skill = registry.skills[skillName];
      if (!skill) throw new UserError(`unknown skill ${skillName}`);
      skillNames = [skillName];
      sourceId = skill.source === "local" ? null : skill.source;
      if (skill.source === "local") {
        localDelete = await this.preflightLocalSkillDelete(registry, skillName);
      } else {
        const otherUsers = Object.entries(registry.skills).filter(([name, candidate]) => name !== skillName && candidate.source === skill.source);
        if (otherUsers.length > 0) {
          retainedSource = true;
        } else {
          sourceDelete = await this.preflightSourceDelete(registry, skill.source);
          delete registry.sources[skill.source];
          delete lock.sources[skill.source];
        }
      }
      delete registry.skills[skillName];
    }

    validateRegistry(registry);
    const trackedChanges = new Set<string>([path.relative(this.paths.root, this.paths.registry)]);
    if (localDelete) for (const file of localDelete.trackedFiles) trackedChanges.add(file);
    if (sourceDelete) {
      trackedChanges.add(".gitmodules");
      trackedChanges.add(path.relative(this.paths.root, this.paths.lock));
      trackedChanges.add(sourceDelete.vendorPath);
    }
    const links = await this.managedLinkPaths(new Set(skillNames));
    const ignoredPaths = sourceDelete?.ignoredPaths ?? [];
    if (request.dryRun) {
      return {
        action, skills: skillNames, sourceId, target: null, trackedChanges: [...trackedChanges], links,
        retainedSource, ignoredPaths, noOp: false, applied: false, syncResult: null,
      };
    }
    const syncResult = request.sync ? await this.reconcileRemoved(registry, await this.store.readProjectBindings(), skillNames) : null;
    if (localDelete) await this.git.run(this.paths.root, ["rm", "-r", "--", localDelete.relativePath]);
    // `git rm` removes a submodule's whole working tree, ignored content included.
    if (sourceDelete) await this.git.run(this.paths.root, ["rm", "--", sourceDelete.vendorPath]);
    await this.store.writeRegistry(registry);
    if (sourceDelete) await this.store.writeLock(lock);
    return {
      action, skills: skillNames, sourceId, target: null, trackedChanges: [...trackedChanges], links,
      retainedSource, ignoredPaths, noOp: false, applied: true, syncResult,
    };
  }

  /**
   * Codex, Kimi Code, Pi, and OpenCode all read a project's `.agents/skills` directory,
   * so selecting a subset of that group still exposes the Skill to the rest. The link
   * set cannot express the difference, so report which agents come along instead of
   * pretending the selection is enforceable.
   */
  private async impliedProjectAgents(
    target: { scope: "global" | "project"; agents: AgentId[] },
    projectRoot: string | null,
  ): Promise<AgentId[]> {
    if (target.scope !== "project" || !projectRoot) return [];
    const selected = new Set<AgentId>(target.agents);
    const selectedDirectories = new Set<string>();
    for (const adapter of this.adapters) {
      if (selected.has(adapter.id)) selectedDirectories.add(await adapter.getProjectSkillDirectory(projectRoot));
    }
    const implied: AgentId[] = [];
    for (const adapter of this.adapters) {
      if (selected.has(adapter.id)) continue;
      if (selectedDirectories.has(await adapter.getProjectSkillDirectory(projectRoot))) implied.push(adapter.id);
    }
    return implied;
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
    const trackedChanges = new Set<string>();
    const localChanges = new Set<string>();
    if (sourceAdded) {
      trackedChanges.add(".gitmodules");
      trackedChanges.add(path.join("vendors", sourceId));
      trackedChanges.add(path.relative(this.paths.root, this.paths.lock));
    }
    // The Skill itself is always registered and pinned, so its content stays reviewed and
    // committed. Only where it lands differs: global reach is committed, a project
    // installation is machine state.
    const skill = existingSkill ?? { source: sourceId, path: skillPath, enabled: true, targets: [] };
    if (!existingSkill) registry.skills[request.skillName] = skill;
    if (!skill.enabled) skill.enabled = true;

    let target: InstalledTarget;
    if (request.scope === "project") {
      if (!request.projectId || !request.projectPath) throw new UserError("project scope requires --project and --project-path");
      const projectRoot = path.resolve(request.projectPath);
      if (projectRoot === path.parse(projectRoot).root) throw new UserError("project path cannot be a filesystem root");
      if (!(await pathExists(this.fs, projectRoot)) || !(await this.fs.lstat(projectRoot)).isDirectory()) {
        throw new UserError(`project is not a directory: ${projectRoot}`);
      }
      const otherBinding = Object.entries(bindings.projects).find(([id, value]) =>
        id !== request.projectId && value.paths.some((candidate) => path.resolve(candidate) === projectRoot),
      );
      if (otherBinding) throw new UserError(`project path is already bound to ${otherBinding[0]}`);
      // Installing from a second worktree of the same repository adds that checkout
      // rather than fighting the first one for the binding.
      const existing = bindings.projects[request.projectId] ?? { paths: [], skills: {} };
      const paths = existing.paths.includes(projectRoot) ? existing.paths : [...existing.paths, projectRoot];
      const installed = existing.skills[request.skillName];
      bindings.projects[request.projectId] = {
        paths,
        skills: { ...existing.skills, [request.skillName]: { agents: mergeAgents(installed?.agents, request.agents) } },
      };
      projectBinding = { id: request.projectId, path: projectRoot, paths };
      target = { scope: "project", project: request.projectId, agents: request.agents };
    } else {
      if (request.projectId || request.projectPath) throw new UserError("project options are not allowed for global scope");
      const matching = skill.targets.find((candidate) => candidate.scope === "global");
      if (matching) matching.agents = mergeAgents(matching.agents, request.agents);
      else skill.targets.push({ scope: "global", agents: request.agents });
      target = { scope: "global", agents: request.agents };
    }

    const originalRegistry = await this.store.readRegistry();
    if (JSON.stringify(registry) !== JSON.stringify(originalRegistry)) trackedChanges.add(path.relative(this.paths.root, this.paths.registry));
    const originalBindings = await this.store.readProjectBindings();
    if (JSON.stringify(bindings) !== JSON.stringify(originalBindings)) localChanges.add(path.relative(this.paths.root, this.paths.projectBindings));
    validateRegistry(registry);
    resolveProjects(bindings);

    const requestedAgents = request.agents.includes("*")
      ? this.adapters.map((adapter) => adapter.id)
      : request.agents.filter((agent): agent is AgentId => agent !== "*");
    const projectRoots = request.scope === "project" ? projectBinding?.paths ?? [] : [null];
    const resolvedLinks: string[] = [];
    for (const projectRoot of projectRoots) {
      for (const agent of requestedAgents) {
        const adapter = this.adapters.find((candidate) => candidate.id === agent);
        if (!adapter) throw new UserError(`no adapter registered for ${agent}`);
        resolvedLinks.push(await adapter.linkPath(request.skillName, projectRoot));
      }
    }
    const links = [...new Set(resolvedLinks)];
    const impliedAgents = await this.impliedProjectAgents(
      { scope: request.scope, agents: requestedAgents },
      projectBinding?.path ?? null,
    );

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
      impliedAgents,
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
      projects = resolveProjects(bindings);
      skills = resolveSkills(registry, this.paths, bindings);
      diagnostics.push({ level: "ok", message: "local project bindings are valid" });
    } catch (error) {
      diagnostics.push({ level: "error", message: `local project bindings are invalid: ${(error as Error).message}` });
      return diagnostics;
    }
    for (const project of projects) {
      if (project.roots.length === 0) {
        diagnostics.push({ level: "error", message: `${project.id}: project is not bound on this device` });
        continue;
      }
      for (const root of project.roots) {
        if (!(await pathExists(this.fs, root))) {
          diagnostics.push({ level: "error", message: `${project.id}: bound path does not exist: ${root}` });
          continue;
        }
        diagnostics.push(
          (await this.fs.lstat(root)).isDirectory()
            ? { level: "ok", message: `${project.id}: bound to ${root}` }
            : { level: "error", message: `${project.id}: bound path is not a directory: ${root}` },
        );
      }
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
      const consumers = link.agents.join("+");
      const label =
        link.scope === "project" ? `${consumers}/${link.projectId}/${link.skill}` : `${consumers}/${link.skill}`;
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

  async update(request: UpdateSourceRequest): Promise<UpdateSourcePlan> {
    const registry = await this.store.readRegistry();
    const lock = structuredClone(await this.store.readLock());
    const config = registry.sources[request.sourceId];
    if (!config) throw new UserError(`unknown source ${request.sourceId}`);
    const source = new GitSource(request.sourceId, config, this.paths.vendors, this.git);
    const info = await source.check(lock.sources[request.sourceId]?.commit ?? null);
    // Both the lock entry and the submodule gitlink move, so both must be committed.
    const noOp = info.current === info.candidate && info.locked === info.candidate;
    const trackedChanges = noOp
      ? []
      : [path.relative(this.paths.root, this.paths.lock), path.join("vendors", config.path ?? request.sourceId)];
    if (noOp || request.dryRun) return { ...info, trackedChanges, noOp, applied: false, syncResult: null };
    await source.update(info.candidate);
    lock.sources[request.sourceId] = { commit: info.candidate };
    await this.store.writeLock(lock);
    return { ...info, trackedChanges, noOp, applied: true, syncResult: request.sync ? await this.sync() : null };
  }

  async setEnabled(request: SetEnabledRequest): Promise<SetEnabledPlan> {
    const registry = structuredClone(await this.store.readRegistry());
    const skill = registry.skills[request.skillName];
    if (!skill) throw new UserError(`unknown skill ${request.skillName}`);
    if (request.enabled && skill.targets.length === 0) {
      throw new UserError(`skill ${request.skillName} has no targets; install it before enabling`);
    }
    const noOp = skill.enabled === request.enabled;
    const trackedChanges = noOp ? [] : [path.relative(this.paths.root, this.paths.registry)];
    const plan = { skill: request.skillName, enabled: request.enabled, trackedChanges, noOp };
    if (noOp || request.dryRun) return { ...plan, applied: false, syncResult: null };
    skill.enabled = request.enabled;
    validateRegistry(registry);
    await this.store.writeRegistry(registry);
    return { ...plan, applied: true, syncResult: request.sync ? await this.sync() : null };
  }
}
