export const agentIds = ["codex", "claude"] as const;

export type AgentId = (typeof agentIds)[number];

export interface GitSourceConfig {
  type: "git";
  repo: string;
  path?: string;
}

export type SourceConfig = GitSourceConfig;

export interface SkillConfig {
  source: "local" | string;
  path: string;
  enabled: boolean;
  agents: Array<AgentId | "*">;
}

export interface RegistryConfig {
  sources: Record<string, SourceConfig>;
  skills: Record<string, SkillConfig>;
}

export interface LockConfig {
  sources: Record<string, { commit: string }>;
}

export interface ResolvedSkill {
  name: string;
  sourceId: string;
  absolutePath: string;
  enabled: boolean;
  agents: AgentId[];
}

export interface ManagedLink {
  agent: AgentId;
  skill: string;
  linkPath: string;
  targetPath: string;
}

export interface ManagedLinksFile {
  version: 1;
  links: ManagedLink[];
}

export interface Diagnostic {
  level: "ok" | "warning" | "error";
  message: string;
}

export interface UpdateInfo {
  source: string;
  current: string | null;
  locked: string | null;
  candidate: string;
  behind: number | null;
}
