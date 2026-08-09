import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "./core/manager.js";
import { projectPaths } from "./core/paths.js";
import { NodeFs } from "./core/fs.js";
import { GitClient } from "./git/client.js";
import { RegistryStore } from "./registry/store.js";
import { errorMessage, UserError } from "./core/errors.js";
import { agentIds, type AgentId, type DeleteSkillRequest, type InstallSkillRequest, type RemoveSkillRequest } from "./core/types.js";

const help = `agent-skills — declarative Agent Skill manager

Usage:
  agent-skills [--root <path>] list
  agent-skills [--root <path>] sync [--skill <name>]
  agent-skills [--root <path>] install <skill> --scope global --agents <agent|*>
    [--repo <url> --source-id <id> --path <skill-path> --ref <ref>]
    [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] install <skill> --scope project --project <id> --project-path <path>
    [--repo <url> --source-id <id> --path <skill-path> --ref <ref>]
    [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --scope global --agents <agent|*> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --scope project --project <id> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --all [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] delete <skill> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] delete --source <id> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] doctor
  agent-skills [--root <path>] check [source]
  agent-skills [--root <path>] diff <source>
  agent-skills [--root <path>] update <source>
  agent-skills [--root <path>] enable <skill>
  agent-skills [--root <path>] disable <skill>
  agent-skills [--root <path>] project list
  agent-skills [--root <path>] project bind <project> <path>
  agent-skills [--root <path>] project unbind <project>

Environment:
  AGENT_SKILLS_ROOT  Registry repository root
  AGENT_SKILLS_HOME  Home directory used by agent adapters (useful for testing)
`;

function findRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, "registry", "skills.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new UserError("could not find registry/skills.yaml; pass --root or set AGENT_SKILLS_ROOT");
}

function parseArguments(argv: string[]): { root: string; command: string; operands: string[] } {
  const args = [...argv];
  let explicitRoot = process.env.AGENT_SKILLS_ROOT;
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0) {
    const value = args[rootIndex + 1];
    if (!value) throw new UserError("--root requires a path");
    explicitRoot = value;
    args.splice(rootIndex, 2);
  }
  if (args[0] === "--help" || args[0] === "-h") return { root: process.cwd(), command: "help", operands: [] };
  const command = args[0] ?? "help";
  return { root: explicitRoot ? path.resolve(explicitRoot) : findRoot(process.cwd()), command, operands: args.slice(1) };
}

function requireOperand(command: string, operands: string[], index = 0): string {
  const operand = operands[index];
  if (!operand) throw new UserError(`${command} requires ${index === 0 ? "a name" : "another argument"}`);
  return operand;
}

function parseOptions(args: string[], booleanNames: string[] = []): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleans = new Set(booleanNames);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name?.startsWith("--")) throw new UserError(`unexpected argument ${name}`);
    if (booleans.has(name)) {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new UserError(`${name} requires a value`);
    if (values.has(name)) throw new UserError(`${name} may only be specified once`);
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function parseAgents(value: string | undefined, command = "install"): Array<AgentId | "*"> {
  if (!value) throw new UserError(`${command} requires --agents`);
  const agents = value.split(",").filter(Boolean);
  if (agents.length === 0 || agents.some((agent) => agent !== "*" && !agentIds.includes(agent as AgentId))) {
    throw new UserError(`unsupported agents ${value}`);
  }
  return agents as Array<AgentId | "*">;
}

async function main(): Promise<void> {
  const { root, command, operands } = parseArguments(process.argv.slice(2));
  if (command === "help") {
    console.log(help);
    return;
  }
  const paths = projectPaths(root);
  const fsPort = new NodeFs();
  const store = new RegistryStore(fsPort, paths);
  const manager = new SkillManager(
    fsPort,
    new GitClient(),
    store,
    paths,
    path.resolve(process.env.AGENT_SKILLS_HOME ?? os.homedir()),
  );

  switch (command) {
    case "list": {
      const skills = await manager.list();
      if (skills.length === 0) {
        console.log("No skills registered.");
        return;
      }
      console.table(
        skills.flatMap((skill) =>
          (skill.targets.length > 0 ? skill.targets : [null]).map((target) => ({
            name: skill.name,
            source: skill.sourceId,
            enabled: skill.enabled ? "yes" : "no",
            scope: target?.scope ?? "-",
            project: target?.scope === "project" ? target.projectId : "-",
            agents: target?.agents.join(",") ?? "-",
            path: path.relative(root, skill.absolutePath),
          })),
        ),
      );
      return;
    }
    case "sync": {
      const options = parseOptions(operands);
      for (const name of options.values.keys()) if (name !== "--skill") throw new UserError(`unknown sync option ${name}`);
      const result = await manager.sync(options.values.get("--skill"));
      console.log(`created ${result.created.length}, removed ${result.removed.length}, unchanged ${result.unchanged.length}`);
      for (const skipped of result.skipped) console.warn(`warning: skipped ${skipped}`);
      return;
    }
    case "install": {
      const skillName = requireOperand(command, operands);
      const options = parseOptions(operands.slice(1), ["--dry-run", "--json", "--no-sync"]);
      const allowed = new Set(["--scope", "--agents", "--repo", "--source-id", "--path", "--ref", "--project", "--project-path"]);
      for (const name of options.values.keys()) if (!allowed.has(name)) throw new UserError(`unknown install option ${name}`);
      const scope = options.values.get("--scope");
      if (scope !== "global" && scope !== "project") throw new UserError("install requires --scope global or project");
      if (scope === "project" && options.values.has("--agents") && options.values.get("--agents") !== "*") {
        throw new UserError("project Skills are shared; omit --agents or use --agents *");
      }
      const request: InstallSkillRequest = {
        skillName,
        scope,
        agents: scope === "project" ? ["*"] : parseAgents(options.values.get("--agents")),
        ...(options.values.get("--repo") ? { repo: options.values.get("--repo") as string } : {}),
        ...(options.values.get("--source-id") ? { sourceId: options.values.get("--source-id") as string } : {}),
        ...(options.values.get("--path") ? { skillPath: options.values.get("--path") as string } : {}),
        ...(options.values.get("--ref") ? { ref: options.values.get("--ref") as string } : {}),
        ...(options.values.get("--project") ? { projectId: options.values.get("--project") as string } : {}),
        ...(options.values.get("--project-path") ? { projectPath: options.values.get("--project-path") as string } : {}),
        dryRun: options.flags.has("--dry-run"),
        sync: !options.flags.has("--no-sync"),
      };
      const plan = await manager.install(request);
      if (options.flags.has("--json")) console.log(JSON.stringify(plan, null, 2));
      else console.log(`${plan.skill}: ${plan.applied ? "installed" : "planned"} ${plan.target.scope} target (${plan.links.length} link(s))`);
      return;
    }
    case "remove": {
      const skillName = requireOperand(command, operands);
      const options = parseOptions(operands.slice(1), ["--all", "--dry-run", "--json", "--no-sync"]);
      const allowed = new Set(["--scope", "--agents", "--project"]);
      for (const name of options.values.keys()) if (!allowed.has(name)) throw new UserError(`unknown remove option ${name}`);
      const scope = options.values.get("--scope");
      if (scope !== undefined && scope !== "global" && scope !== "project") throw new UserError("remove --scope must be global or project");
      const request: RemoveSkillRequest = {
        skillName,
        ...(scope ? { scope } : {}),
        ...(options.values.has("--agents") ? { agents: parseAgents(options.values.get("--agents"), "remove") } : {}),
        ...(options.values.has("--project") ? { projectId: options.values.get("--project") as string } : {}),
        all: options.flags.has("--all"),
        dryRun: options.flags.has("--dry-run"),
        sync: !options.flags.has("--no-sync"),
      };
      const plan = await manager.remove(request);
      if (options.flags.has("--json")) console.log(JSON.stringify(plan, null, 2));
      else console.log(plan.noOp ? `${skillName}: no matching target` : `${skillName}: ${plan.applied ? "removed" : "planned"}`);
      return;
    }
    case "delete": {
      const first = operands[0];
      const hasSkillName = Boolean(first && !first.startsWith("--"));
      const options = parseOptions(operands.slice(hasSkillName ? 1 : 0), ["--dry-run", "--json", "--no-sync"]);
      for (const name of options.values.keys()) if (name !== "--source") throw new UserError(`unknown delete option ${name}`);
      const request: DeleteSkillRequest = {
        ...(hasSkillName ? { skillName: first as string } : {}),
        ...(options.values.has("--source") ? { sourceId: options.values.get("--source") as string } : {}),
        dryRun: options.flags.has("--dry-run"),
        sync: !options.flags.has("--no-sync"),
      };
      const plan = await manager.delete(request);
      if (options.flags.has("--json")) console.log(JSON.stringify(plan, null, 2));
      else console.log(`${plan.skills.join(",") || plan.sourceId}: ${plan.applied ? "deleted" : "planned"}`);
      return;
    }
    case "doctor": {
      const diagnostics = await manager.doctor();
      for (const item of diagnostics) {
        const marker = item.level === "ok" ? "✓" : item.level === "warning" ? "⚠" : "✗";
        console.log(`${marker} ${item.message}`);
      }
      if (diagnostics.some((item) => item.level === "error")) process.exitCode = 1;
      return;
    }
    case "check": {
      const updates = await manager.check(operands[0]);
      if (updates.length === 0) console.log("No git sources registered.");
      for (const update of updates) {
        const status = update.current === update.candidate ? "up to date" : `${update.behind ?? "?"} commit(s) behind`;
        console.log(`${update.source}: ${status} (${update.current?.slice(0, 8)} → ${update.candidate.slice(0, 8)})`);
      }
      return;
    }
    case "diff":
      console.log((await manager.diff(requireOperand(command, operands))) || "No relevant changes.");
      return;
    case "update": {
      const update = await manager.update(requireOperand(command, operands));
      console.log(`${update.source}: updated to ${update.candidate}`);
      return;
    }
    case "enable":
    case "disable": {
      const skill = requireOperand(command, operands);
      await manager.setEnabled(skill, command === "enable");
      console.log(`${skill}: ${command}d; run agent-skills sync to apply`);
      return;
    }
    case "project": {
      const action = requireOperand("project", operands);
      if (action === "list") {
        const projects = await manager.listProjects();
        if (projects.length === 0) console.log("No projects registered.");
        else console.table(projects.map((project) => ({ project: project.id, status: project.root ? "bound" : "unbound", path: project.root ?? "-" })));
        return;
      }
      if (action !== "bind" && action !== "unbind") throw new UserError(`unknown project command ${action}`);
      const projectId = requireOperand(`project ${action}`, operands, 1);
      if (action === "bind") {
        const projectPath = requireOperand("project bind", operands, 2);
        console.log(`${projectId}: bound to ${await manager.bindProject(projectId, projectPath)}`);
        return;
      }
      if (action === "unbind") {
        await manager.unbindProject(projectId);
        console.log(`${projectId}: unbound`);
        return;
      }
      return;
    }
    default:
      throw new UserError(`unknown command ${command}\n\n${help}`);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
