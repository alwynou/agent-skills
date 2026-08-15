import { spawn } from "node:child_process";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Publishing runs commands whose failure is sometimes expected — `git add` on a path the
 * manager already removed, `git push` against a moved remote — so it needs the exit
 * status rather than an exception. `GitPort` throws, which is right for the manager and
 * wrong here.
 */
export interface CommandPort {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export class NodeCommand implements CommandPort {
  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (status) => resolve({ status: status ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
    });
  }
}
