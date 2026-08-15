import path from "node:path";
import type { AgentId } from "../core/types.js";

export interface AgentAdapter {
  id: AgentId;
  name: string;
  detect(): Promise<boolean>;
  getGlobalSkillDirectory(): Promise<string>;
  getProjectSkillDirectory(projectRoot: string): Promise<string>;
  /** Passing `null` asks for the Agent's global directory instead of a project one. */
  linkPath(skillName: string, projectRoot: string | null): Promise<string>;
}

abstract class HomeAgentAdapter implements AgentAdapter {
  abstract id: AgentId;
  abstract name: string;
  abstract relativeDirectory: string;
  abstract projectRelativeDirectory: string;

  constructor(protected readonly home: string) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async getGlobalSkillDirectory(): Promise<string> {
    return path.join(this.home, this.relativeDirectory);
  }

  async getProjectSkillDirectory(projectRoot: string): Promise<string> {
    return path.join(projectRoot, this.projectRelativeDirectory);
  }

  async linkPath(skillName: string, projectRoot: string | null): Promise<string> {
    const directory = projectRoot === null
      ? await this.getGlobalSkillDirectory()
      : await this.getProjectSkillDirectory(projectRoot);
    return path.join(directory, skillName);
  }
}

export class CodexAdapter extends HomeAgentAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex";
  readonly relativeDirectory = path.join(".agents", "skills");
  readonly projectRelativeDirectory = path.join(".agents", "skills");
}

export class ClaudeCodeAdapter extends HomeAgentAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude Code";
  readonly relativeDirectory = path.join(".claude", "skills");
  readonly projectRelativeDirectory = path.join(".claude", "skills");
}

export class KimiCodeAdapter extends HomeAgentAdapter {
  readonly id = "kimi-code" as const;
  readonly name = "Kimi Code";
  readonly relativeDirectory = path.join(".kimi-code", "skills");
  readonly projectRelativeDirectory = path.join(".agents", "skills");
}

export class PiAgentAdapter extends HomeAgentAdapter {
  readonly id = "pi-agent" as const;
  readonly name = "Pi Coding Agent";
  readonly relativeDirectory = path.join(".pi", "agent", "skills");
  readonly projectRelativeDirectory = path.join(".agents", "skills");
}

export class OpenCodeAdapter extends HomeAgentAdapter {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  readonly relativeDirectory = path.join(".config", "opencode", "skills");
  readonly projectRelativeDirectory = path.join(".agents", "skills");
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
