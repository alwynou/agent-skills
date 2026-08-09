import { spawn } from "node:child_process";
import { UserError } from "../core/errors.js";

export interface GitPort {
  run(cwd: string, args: string[]): Promise<string>;
}

export class GitClient implements GitPort {
  async run(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new UserError(`git ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }
}
