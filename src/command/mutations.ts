import type { SkillManager } from "../core/manager.js";
import { UserError } from "../core/errors.js";
import type { DeleteSkillRequest, InstallSkillPlan, InstallSkillRequest, RemoveSkillRequest, SetEnabledPlan, SkillRemovalPlan, UpdateSourcePlan } from "../core/types.js";
import { parseAgents, parseOptions, rejectUnknown, requireOperand } from "./args.js";

/**
 * Every mutating command reports what would be committed, whether anything changed at
 * all, and whether it was applied. Publishing reads only those three fields; the rest of
 * each plan travels through untouched for reporting.
 */
export type MutationPlan =
  | (InstallSkillPlan & { noOp: boolean })
  | SkillRemovalPlan
  | UpdateSourcePlan
  | SetEnabledPlan;

export const mutatingCommands = ["install", "remove", "delete", "update", "enable", "disable"] as const;

export type MutatingCommand = (typeof mutatingCommands)[number];

export function isMutatingCommand(value: string): value is MutatingCommand {
  return (mutatingCommands as readonly string[]).includes(value);
}

export interface MutationOptions {
  dryRun: boolean;
  sync: boolean;
}

const booleanFlags = ["--dry-run", "--json", "--no-sync"];

/** Reads the shared `--dry-run` / `--no-sync` / `--json` flags out of a command's operands. */
export function mutationFlags(command: MutatingCommand, operands: string[]): { options: MutationOptions; json: boolean } {
  // `delete --source <id>` carries no leading skill name; every other form does.
  const skip = command === "delete" && operands[0]?.startsWith("--") ? 0 : 1;
  const { flags } = parseOptions(operands.slice(skip), [...booleanFlags, "--all"]);
  return {
    options: { dryRun: flags.has("--dry-run"), sync: !flags.has("--no-sync") },
    json: flags.has("--json"),
  };
}

/**
 * Turns one mutating command's operands into a manager call. Both the plain CLI path
 * and the publishing path go through here so a flag is only ever parsed in one place.
 */
export async function applyMutation(
  manager: SkillManager,
  command: MutatingCommand,
  operands: string[],
  options: MutationOptions,
): Promise<MutationPlan> {
  switch (command) {
    case "install": {
      const skillName = requireOperand(command, operands);
      const { values } = parseOptions(operands.slice(1), booleanFlags);
      rejectUnknown(command, values, ["--scope", "--agents", "--repo", "--source-id", "--path", "--ref", "--project", "--project-path"]);
      const scope = values.get("--scope");
      if (scope !== "global" && scope !== "project") throw new UserError("install requires --scope global or project");
      const request: InstallSkillRequest = {
        skillName,
        scope,
        agents: scope === "project" && !values.has("--agents") ? ["*"] : parseAgents(values.get("--agents")),
        ...(values.get("--repo") ? { repo: values.get("--repo") as string } : {}),
        ...(values.get("--source-id") ? { sourceId: values.get("--source-id") as string } : {}),
        ...(values.get("--path") ? { skillPath: values.get("--path") as string } : {}),
        ...(values.get("--ref") ? { ref: values.get("--ref") as string } : {}),
        ...(values.get("--project") ? { projectId: values.get("--project") as string } : {}),
        ...(values.get("--project-path") ? { projectPath: values.get("--project-path") as string } : {}),
        ...options,
      };
      const plan = await manager.install(request);
      return { ...plan, noOp: plan.trackedChanges.length === 0 && plan.localChanges.length === 0 };
    }
    case "remove": {
      const skillName = requireOperand(command, operands);
      const { values, flags } = parseOptions(operands.slice(1), [...booleanFlags, "--all"]);
      rejectUnknown(command, values, ["--scope", "--agents", "--project"]);
      const scope = values.get("--scope");
      if (scope !== undefined && scope !== "global" && scope !== "project") throw new UserError("remove --scope must be global or project");
      const request: RemoveSkillRequest = {
        skillName,
        ...(scope ? { scope } : {}),
        ...(values.has("--agents") ? { agents: parseAgents(values.get("--agents"), "remove") } : {}),
        ...(values.has("--project") ? { projectId: values.get("--project") as string } : {}),
        all: flags.has("--all"),
        ...options,
      };
      return manager.remove(request);
    }
    case "delete": {
      const first = operands[0];
      const hasSkillName = Boolean(first && !first.startsWith("--"));
      const { values } = parseOptions(operands.slice(hasSkillName ? 1 : 0), booleanFlags);
      rejectUnknown(command, values, ["--source"]);
      const request: DeleteSkillRequest = {
        ...(hasSkillName ? { skillName: first as string } : {}),
        ...(values.has("--source") ? { sourceId: values.get("--source") as string } : {}),
        ...options,
      };
      return manager.delete(request);
    }
    case "update": {
      const sourceId = requireOperand(command, operands);
      const { values } = parseOptions(operands.slice(1), booleanFlags);
      rejectUnknown(command, values, []);
      return manager.update({ sourceId, ...options });
    }
    case "enable":
    case "disable": {
      const skillName = requireOperand(command, operands);
      const { values } = parseOptions(operands.slice(1), booleanFlags);
      rejectUnknown(command, values, []);
      return manager.setEnabled({ skillName, enabled: command === "enable", ...options });
    }
  }
}

/** One-line human summary; `--json` callers print the plan instead. */
export function formatMutation(command: MutatingCommand, plan: MutationPlan): string {
  switch (command) {
    case "install": {
      const installed = plan as InstallSkillPlan;
      return `${installed.skill}: ${installed.applied ? "installed" : "planned"} ${installed.target.scope} target (${installed.links.length} link(s))`;
    }
    case "remove": {
      const removed = plan as SkillRemovalPlan;
      const name = removed.skills[0] ?? "";
      return removed.noOp ? `${name}: no matching target` : `${name}: ${removed.applied ? "removed" : "planned"}`;
    }
    case "delete": {
      const deleted = plan as SkillRemovalPlan;
      return `${deleted.skills.join(",") || deleted.sourceId}: ${deleted.applied ? "deleted" : "planned"}`;
    }
    case "update": {
      const updated = plan as UpdateSourcePlan;
      const candidate = updated.candidate.slice(0, 8);
      if (updated.noOp) return `${updated.source}: already at ${candidate}`;
      return `${updated.source}: ${updated.applied ? "updated" : "planned"} ${updated.current?.slice(0, 8)} \u2192 ${candidate}`;
    }
    case "enable":
    case "disable": {
      const toggled = plan as SetEnabledPlan;
      if (toggled.noOp) return `${toggled.skill}: already ${command}d`;
      return `${toggled.skill}: ${toggled.applied ? `${command}d` : `planned ${command}`}`;
    }
  }
}
