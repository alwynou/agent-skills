import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "./core/manager.js";
import { projectPaths } from "./core/paths.js";
import { NodeFs } from "./core/fs.js";
import { GitClient } from "./git/client.js";
import { RegistryStore } from "./registry/store.js";
import { errorMessage, UserError } from "./core/errors.js";

const help = `agent-skills — declarative Agent Skill manager

Usage:
  agent-skills [--root <path>] list
  agent-skills [--root <path>] sync
  agent-skills [--root <path>] doctor
  agent-skills [--root <path>] check [source]
  agent-skills [--root <path>] diff <source>
  agent-skills [--root <path>] update <source>
  agent-skills [--root <path>] enable <skill>
  agent-skills [--root <path>] disable <skill>

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

function parseArguments(argv: string[]): { root: string; command: string; operand?: string } {
  const args = [...argv];
  let explicitRoot = process.env.AGENT_SKILLS_ROOT;
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0) {
    const value = args[rootIndex + 1];
    if (!value) throw new UserError("--root requires a path");
    explicitRoot = value;
    args.splice(rootIndex, 2);
  }
  if (args[0] === "--help" || args[0] === "-h") return { root: process.cwd(), command: "help" };
  const command = args[0] ?? "help";
  return { root: explicitRoot ? path.resolve(explicitRoot) : findRoot(process.cwd()), command, ...(args[1] ? { operand: args[1] } : {}) };
}

function requireOperand(command: string, operand?: string): string {
  if (!operand) throw new UserError(`${command} requires a name`);
  return operand;
}

async function main(): Promise<void> {
  const { root, command, operand } = parseArguments(process.argv.slice(2));
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
          skill.targets.map((target) => ({
            name: skill.name,
            source: skill.sourceId,
            enabled: skill.enabled ? "yes" : "no",
            scope: target.scope,
            project: target.scope === "project" ? target.projectId : "-",
            agents: target.agents.join(","),
            path: path.relative(root, skill.absolutePath),
          })),
        ),
      );
      return;
    }
    case "sync": {
      const result = await manager.sync();
      console.log(`created ${result.created.length}, removed ${result.removed.length}, unchanged ${result.unchanged.length}`);
      for (const skipped of result.skipped) console.warn(`warning: skipped ${skipped}`);
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
      const updates = await manager.check(operand);
      if (updates.length === 0) console.log("No git sources registered.");
      for (const update of updates) {
        const status = update.current === update.candidate ? "up to date" : `${update.behind ?? "?"} commit(s) behind`;
        console.log(`${update.source}: ${status} (${update.current?.slice(0, 8)} → ${update.candidate.slice(0, 8)})`);
      }
      return;
    }
    case "diff":
      console.log((await manager.diff(requireOperand(command, operand))) || "No relevant changes.");
      return;
    case "update": {
      const update = await manager.update(requireOperand(command, operand));
      console.log(`${update.source}: updated to ${update.candidate}`);
      return;
    }
    case "enable":
    case "disable": {
      const skill = requireOperand(command, operand);
      await manager.setEnabled(skill, command === "enable");
      console.log(`${skill}: ${command}d; run agent-skills sync to apply`);
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
