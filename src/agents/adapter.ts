import path from "node:path";
import type { AgentId, ResolvedSkill } from "../core/types.js";

export interface AgentAdapter {
  id: AgentId;
  name: string;
  detect(): Promise<boolean>;
  getGlobalSkillDirectory(): Promise<string>;
  linkPath(skill: ResolvedSkill): Promise<string>;
}

abstract class HomeAgentAdapter implements AgentAdapter {
  abstract id: AgentId;
  abstract name: string;
  abstract relativeDirectory: string;

  constructor(protected readonly home: string) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async getGlobalSkillDirectory(): Promise<string> {
    return path.join(this.home, this.relativeDirectory);
  }

  async linkPath(skill: ResolvedSkill): Promise<string> {
    return path.join(await this.getGlobalSkillDirectory(), skill.name);
  }
}

export class CodexAdapter extends HomeAgentAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";
  readonly relativeDirectory = path.join(".agents", "skills");
}

export class ClaudeCodeAdapter extends HomeAgentAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude Code";
  readonly relativeDirectory = path.join(".claude", "skills");
}

export class KimiCodeAdapter extends HomeAgentAdapter {
  readonly id = "kimi-code" as const;
  readonly name = "Kimi Code";
  readonly relativeDirectory = path.join(".kimi-code", "skills");
}

export class PiAgentAdapter extends HomeAgentAdapter {
  readonly id = "pi-agent" as const;
  readonly name = "Pi Coding Agent";
  readonly relativeDirectory = path.join(".pi", "agent", "skills");
}

export class OpenCodeAdapter extends HomeAgentAdapter {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  readonly relativeDirectory = path.join(".config", "opencode", "skills");
}

export function builtInAdapters(home: string): AgentAdapter[] {
  return [
    new CodexAdapter(home),
    new ClaudeCodeAdapter(home),
    new KimiCodeAdapter(home),
    new PiAgentAdapter(home),
    new OpenCodeAdapter(home),
  ];
}
