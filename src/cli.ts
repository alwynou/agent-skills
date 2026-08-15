import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "./core/manager.js";
import { projectPaths } from "./core/paths.js";
import { NodeFs } from "./core/fs.js";
import { GitClient } from "./git/client.js";
import { RegistryStore } from "./registry/store.js";
import { errorMessage, UserError } from "./core/errors.js";
import { formatSkillDetail } from "./core/skill-detail.js";
import { parseOptions, rejectUnknown, requireOperand } from "./command/args.js";
import { applyMutation, formatMutation, isMutatingCommand, mutationFlags, type MutatingCommand } from "./command/mutations.js";
import { publish } from "./publish/publisher.js";
import { NodeCommand } from "./publish/process.js";

const help = `agent-skills — declarative Agent Skill manager

Usage:
  agent-skills [--root <path>] list
  agent-skills [--root <path>] show <skill> [--json]
  agent-skills [--root <path>] sync [--skill <name>]
  agent-skills [--root <path>] install <skill> --scope global --agents <agent|*>
    [--repo <url> --source-id <id> --path <skill-path> --ref <ref>]
    [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] install <skill> --scope project --project <id> --project-path <path>
    [--agents <agent|*>] [--repo <url> --source-id <id> --path <skill-path> --ref <ref>]
    [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --scope global --agents <agent|*> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --scope project --project <id> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] remove <skill> --all [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] delete <skill> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] delete --source <id> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] publish --title <commit-title> [--no-push] -- <mutating command> [args...]
  agent-skills [--root <path>] doctor
  agent-skills [--root <path>] check [source]
  agent-skills [--root <path>] diff <source>
  agent-skills [--root <path>] update <source> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] enable <skill> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] disable <skill> [--dry-run] [--json] [--no-sync]
  agent-skills [--root <path>] project list
  agent-skills [--root <path>] project bind <project> <path>
  agent-skills [--root <path>] project unbind <project> [path]

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

async function runMutation(manager: SkillManager, command: MutatingCommand, operands: string[]): Promise<void> {
  const { options, json } = mutationFlags(command, operands);
  const plan = await applyMutation(manager, command, operands, options);
  console.log(json ? JSON.stringify(plan, null, 2) : formatMutation(command, plan));
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
    case "show": {
      const skillName = requireOperand(command, operands);
      const options = parseOptions(operands.slice(1), ["--json"]);
      for (const name of options.values.keys()) throw new UserError(`unknown show option ${name}`);
      const detail = await manager.show(skillName);
      console.log(options.flags.has("--json") ? JSON.stringify(detail, null, 2) : formatSkillDetail(detail));
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
    case "install":
    case "remove":
    case "delete": {
      await runMutation(manager, command, operands);
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
    case "update":
    case "enable":
    case "disable": {
      await runMutation(manager, command, operands);
      return;
    }
    case "publish": {
      const separator = operands.indexOf("--");
      if (separator < 0) throw new UserError("publish requires -- followed by the command to publish");
      const { values, flags } = parseOptions(operands.slice(0, separator), ["--no-push"]);
      rejectUnknown(command, values, ["--title"]);
      const title = values.get("--title");
      if (!title) throw new UserError("publish requires --title");
      const [inner, ...innerOperands] = operands.slice(separator + 1);
      if (!inner || !isMutatingCommand(inner)) throw new UserError(`publish cannot run ${inner ?? "<end>"}`);
      const result = await publish(new NodeCommand(), {
        root,
        title,
        push: !flags.has("--no-push"),
        apply: (options) => applyMutation(manager, inner, innerOperands, options),
        // Installing reconciles just that Skill; a removal has to sweep the whole
        // manifest because the Skill is already gone from the registry.
        sync: () => manager.sync(inner === "install" ? innerOperands[0] : undefined),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.pushError) console.warn(`warning: committed on main but not pushed: ${result.pushError}`);
      return;
    }
    case "project": {
      const action = requireOperand("project", operands);
      if (action === "list") {
        const projects = await manager.listProjects();
        if (projects.length === 0) console.log("No projects registered.");
        else {
          console.table(projects.flatMap((project) =>
            (project.roots.length > 0 ? project.roots : [null]).map((root) => ({
              project: project.id,
              status: root ? "bound" : "unbound",
              path: root ?? "-",
            })),
          ));
        }
        return;
      }
      if (action !== "bind" && action !== "unbind") throw new UserError(`unknown project command ${action}`);
      const projectId = requireOperand(`project ${action}`, operands, 1);
      if (action === "bind") {
        const projectPath = requireOperand("project bind", operands, 2);
        const paths = await manager.bindProject(projectId, projectPath);
        console.log(`${projectId}: bound to ${paths.join(", ")}`);
        return;
      }
      if (action === "unbind") {
        const remaining = await manager.unbindProject(projectId, operands[2]);
        console.log(remaining.length > 0 ? `${projectId}: still bound to ${remaining.join(", ")}` : `${projectId}: unbound`);
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
