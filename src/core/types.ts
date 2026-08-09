export const agentIds = ["codex", "claude", "kimi-code", "pi-agent", "opencode"] as const;

export type AgentId = (typeof agentIds)[number];

export interface GitSourceConfig {
  type: "git";
  repo: string;
  path?: string;
}

export type SourceConfig = GitSourceConfig;

export interface ProjectConfig {
  path: string;
}

export interface GlobalSkillTargetConfig {
  scope: "global";
  agents: Array<AgentId | "*">;
}

export interface ProjectSkillTargetConfig {
  scope: "project";
  project: string;
  agents: Array<AgentId | "*">;
}

export type SkillTargetConfig = GlobalSkillTargetConfig | ProjectSkillTargetConfig;

export interface SkillConfig {
  source: "local" | string;
  path: string;
  enabled: boolean;
  agents?: Array<AgentId | "*">;
  targets?: SkillTargetConfig[];
}

export interface RegistryConfig {
  sources: Record<string, SourceConfig>;
  projects: Record<string, ProjectConfig>;
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
  targets: ResolvedSkillTarget[];
}

export interface ResolvedGlobalSkillTarget {
  scope: "global";
  agents: AgentId[];
}

export interface ResolvedProjectSkillTarget {
  scope: "project";
  agents: AgentId[];
  projectId: string;
  projectRoot: string;
}

export type ResolvedSkillTarget = ResolvedGlobalSkillTarget | ResolvedProjectSkillTarget;

export interface ManagedLink {
  agent: AgentId;
  skill: string;
  scope: "global" | "project";
  projectId?: string;
  projectRoot?: string;
  linkPath: string;
  targetPath: string;
}

export interface ManagedLinksFile {
  version: 2;
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
