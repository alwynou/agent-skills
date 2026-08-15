import { agentIds, type AgentId } from "../core/types.js";
import { UserError } from "../core/errors.js";

export interface ParsedOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

export function parseOptions(args: string[], booleanNames: string[] = []): ParsedOptions {
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

export function rejectUnknown(command: string, values: Map<string, string>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  for (const name of values.keys()) if (!permitted.has(name)) throw new UserError(`unknown ${command} option ${name}`);
}

export function requireOperand(command: string, operands: string[], index = 0): string {
  const operand = operands[index];
  if (!operand) throw new UserError(`${command} requires ${index === 0 ? "a name" : "another argument"}`);
  return operand;
}

export function parseAgents(value: string | undefined, command = "install"): Array<AgentId | "*"> {
  if (!value) throw new UserError(`${command} requires --agents`);
  const agents = value.split(",").filter(Boolean);
  if (agents.length === 0 || agents.some((agent) => agent !== "*" && !agentIds.includes(agent as AgentId))) {
    throw new UserError(`unsupported agents ${value}`);
  }
  return agents as Array<AgentId | "*">;
}
