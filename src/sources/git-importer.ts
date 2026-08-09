import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitPort } from "../git/client.js";
import { UserError } from "../core/errors.js";

export interface PreparedGitImport {
  commit: string;
}

export class GitImporter {
  constructor(private readonly git: GitPort) {}

  async inspect(repo: string, ref: string | undefined, skillPath: string): Promise<PreparedGitImport> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-import-"));
    const checkout = path.join(temporaryRoot, "source");
    try {
      await this.git.run(temporaryRoot, ["-c", "protocol.file.allow=always", "clone", "--quiet", repo, checkout]);
      if (ref) await this.git.run(checkout, ["fetch", "--quiet", "origin", ref]);
      const commit = await this.git.run(checkout, ["rev-parse", `${ref ? "FETCH_HEAD" : "HEAD"}^{commit}`]);
      await this.git.run(checkout, ["checkout", "--quiet", "--detach", commit]);
      const root = path.resolve(checkout);
      const skillRoot = path.resolve(root, skillPath);
      if (skillRoot !== root && !skillRoot.startsWith(`${root}${path.sep}`)) throw new UserError("skill path escapes its source root");
      const stat = await fs.stat(path.join(skillRoot, "SKILL.md")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new UserError(`source is missing ${skillPath}/SKILL.md`);
        throw error;
      });
      if (!stat.isFile()) throw new UserError(`source is missing ${skillPath}/SKILL.md`);
      return { commit };
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async addSubmodule(root: string, sourceId: string, repo: string, vendorPath: string, commit: string): Promise<void> {
    await this.git.run(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--name",
      sourceId,
      repo,
      vendorPath,
    ]);
    await this.git.run(path.join(root, vendorPath), ["fetch", "--quiet", "origin", commit]);
    await this.git.run(path.join(root, vendorPath), ["checkout", "--quiet", "--detach", commit]);
  }
}
