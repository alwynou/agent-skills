import path from "node:path";
import type { GitPort } from "../git/client.js";
import type { GitSourceConfig, UpdateInfo } from "../core/types.js";
import { UserError } from "../core/errors.js";

export class GitSource {
  readonly directory: string;

  constructor(
    readonly id: string,
    readonly config: GitSourceConfig,
    vendorsDirectory: string,
    private readonly git: GitPort,
  ) {
    this.directory = path.resolve(vendorsDirectory, config.path ?? id);
  }

  async currentCommit(): Promise<string> {
    return this.git.run(this.directory, ["rev-parse", "HEAD"]);
  }

  async fetchCandidate(): Promise<string> {
    await this.git.run(this.directory, ["fetch", "--quiet", "origin"]);
    try {
      return await this.git.run(this.directory, ["rev-parse", "origin/HEAD"]);
    } catch {
      return this.git.run(this.directory, ["rev-parse", "FETCH_HEAD"]);
    }
  }

  async check(locked: string | null): Promise<UpdateInfo> {
    const current = await this.currentCommit();
    const candidate = await this.fetchCandidate();
    let behind: number | null = null;
    try {
      const count = await this.git.run(this.directory, ["rev-list", "--count", `${current}..${candidate}`]);
      behind = Number.parseInt(count, 10);
    } catch {
      // Diverged histories are still reported through commit IDs.
    }
    return { source: this.id, current, locked, candidate, behind };
  }

  async diff(from: string, to: string, paths: string[]): Promise<string> {
    return this.git.run(this.directory, ["diff", "--stat", from, to, "--", ...paths]);
  }

  async update(candidate: string): Promise<void> {
    const status = await this.git.run(this.directory, ["status", "--porcelain"]);
    if (status !== "") throw new UserError(`source ${this.id} has local changes; refusing to update`);
    await this.git.run(this.directory, ["merge-base", "--is-ancestor", "HEAD", candidate]);
    await this.git.run(this.directory, ["checkout", "--detach", candidate]);
  }
}
