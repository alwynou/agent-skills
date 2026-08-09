export const agentIds = ["codex", "claude", "kimi-code", "pi-agent", "opencode"] as const;

export type AgentId = (typeof agentIds)[number];

export interface GitSourceConfig {
  type: "git";
  repo: string;
  path?: string;
}

export type SourceConfig = GitSourceConfig;

export interface ProjectBindingsConfig {
  projects: Record<string, { path: string }>;
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
  targets: SkillTargetConfig[];
}

export interface RegistryConfig {
  sources: Record<string, SourceConfig>;
  projects: string[];
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
  projectRoot: string | null;
}

export type ResolvedSkillTarget = ResolvedGlobalSkillTarget | ResolvedProjectSkillTarget;

export interface ResolvedProject {
  id: string;
  root: string | null;
  source: "local" | "unbound";
}

export interface ManagedLink {
  agents: AgentId[];
  skill: string;
  scope: "global" | "project";
  projectId?: string;
  projectRoot?: string;
  linkPath: string;
  targetPath: string;
}

export interface ManagedLinksFile {
  version: 3;
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

export interface InstallSkillRequest {
  skillName: string;
  scope: "global" | "project";
  agents: Array<AgentId | "*">;
  repo?: string;
  sourceId?: string;
  skillPath?: string;
  ref?: string;
  projectId?: string;
  projectPath?: string;
  dryRun: boolean;
  sync: boolean;
}

export interface InstallSkillPlan {
  skill: string;
  source: { id: string; repo: string | null; commit: string | null; added: boolean };
  skillPath: string;
  target: SkillTargetConfig;
  projectBinding: { id: string; path: string } | null;
  trackedChanges: string[];
  localChanges: string[];
  links: string[];
  applied: boolean;
}
