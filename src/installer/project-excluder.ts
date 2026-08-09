import path from "node:path";
import type { FsPort } from "../core/fs.js";
import { atomicWrite, pathExists } from "../core/fs.js";
import { UserError } from "../core/errors.js";
import type { ManagedLink } from "../core/types.js";
import type { GitPort } from "../git/client.js";

const beginMarker = "# BEGIN agent-skills-manager project links";
const endMarker = "# END agent-skills-manager project links";

interface ExcludeState {
  path: string;
  content: string;
  patterns: Set<string>;
}

function escapePattern(relativePath: string): string {
  return `/${relativePath.split(path.sep).join("/").replace(/[\\*?\[\]#! ]/g, "\\$&")}`;
}

function parseManagedBlock(content: string, filePath: string): { lines: string[]; begin?: number; end?: number } {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const begins = lines.flatMap((line, index) => (line === beginMarker ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === endMarker ? [index] : []));
  if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length || (begins[0] ?? 0) > (ends[0] ?? 0)) {
    throw new UserError(`${filePath}: malformed agent-skills-manager exclude block`);
  }
  return begins.length === 1 ? { lines, begin: begins[0] as number, end: ends[0] as number } : { lines };
}

function replaceManagedBlock(content: string, patterns: string[], filePath: string): string {
  const parsed = parseManagedBlock(content, filePath);
  const { lines } = parsed;

  let before = lines;
  let after: string[] = [];
  if (parsed.begin !== undefined) {
    before = lines.slice(0, parsed.begin);
    after = lines.slice((parsed.end as number) + 1);
  }
  while (before.at(-1) === "") before.pop();
  while (after[0] === "") after.shift();

  const block = patterns.length > 0 ? [beginMarker, ...patterns, endMarker] : [];
  const output = [...before, ...(before.length > 0 && block.length > 0 ? [""] : []), ...block, ...(block.length > 0 && after.length > 0 ? [""] : []), ...after];
  return output.length > 0 ? `${output.join("\n")}\n` : "";
}

export class ProjectExcluder {
  constructor(
    private readonly fs: FsPort,
    private readonly git: GitPort,
  ) {}

  private async gitInfo(link: ManagedLink): Promise<{ excludePath: string; pattern: string } | null> {
    if (!link.projectRoot) return null;
    let canonicalProjectRoot: string;
    try {
      canonicalProjectRoot = await this.fs.realpath(link.projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const gitRoot = path.resolve(await this.git.run(link.projectRoot, ["rev-parse", "--show-toplevel"]));
      const rawExcludePath = await this.git.run(link.projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
      const canonicalLinkPath = path.resolve(canonicalProjectRoot, path.relative(link.projectRoot, link.linkPath));
      const relativeLink = path.relative(gitRoot, canonicalLinkPath);
      if (relativeLink === "" || relativeLink === ".." || relativeLink.startsWith(`..${path.sep}`)) return null;
      return { excludePath: path.resolve(canonicalProjectRoot, rawExcludePath), pattern: escapePattern(relativeLink) };
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("not a git repository") || message.includes("must be run in a work tree")) return null;
      throw error;
    }
  }

  async prepare(desired: ManagedLink[], previous: ManagedLink[]): Promise<() => Promise<void>> {
    const states = new Map<string, ExcludeState>();
    const desiredPaths = new Set(desired.map((link) => link.linkPath));
    const allProjectLinks = [
      ...desired.filter((link) => link.scope === "project"),
      ...previous.filter((link) => link.scope === "project"),
    ];

    for (const link of allProjectLinks) {
      const info = await this.gitInfo(link);
      if (!info) continue;
      const { excludePath } = info;

      let state = states.get(excludePath);
      if (!state) {
        const content = (await pathExists(this.fs, excludePath)) ? await this.fs.readFile(excludePath) : "";
        replaceManagedBlock(content, [], excludePath);
        state = { path: excludePath, content, patterns: new Set() };
        states.set(excludePath, state);
      }
      if (desiredPaths.has(link.linkPath)) {
        state.patterns.add(info.pattern);
      }
    }

    return async () => {
      for (const state of states.values()) {
        const next = replaceManagedBlock(state.content, [...state.patterns].sort(), state.path);
        if (next !== state.content) await atomicWrite(this.fs, state.path, next);
      }
    };
  }

  async diagnose(desired: ManagedLink[]): Promise<string[]> {
    const issues: string[] = [];
    for (const link of desired.filter((candidate) => candidate.scope === "project")) {
      const info = await this.gitInfo(link);
      if (!info) continue;
      try {
        const content = (await pathExists(this.fs, info.excludePath)) ? await this.fs.readFile(info.excludePath) : "";
        const parsed = parseManagedBlock(content, info.excludePath);
        const patterns =
          parsed.begin === undefined ? [] : parsed.lines.slice(parsed.begin + 1, parsed.end as number);
        if (!patterns.includes(info.pattern)) {
          issues.push(`${link.agent}/${link.projectId}/${link.skill}: Git exclude entry is missing`);
        }
      } catch (error) {
        issues.push((error as Error).message);
      }
    }
    return [...new Set(issues)];
  }
}
