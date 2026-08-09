import { spawnSync } from "node:child_process";

function readConfig(root, scope, key, env) {
  const result = spawnSync("git", ["config", `--${scope}`, "--get", key], {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function resolveGitIdentity(root, env = process.env) {
  const name = readConfig(root, "local", "user.name", env) ?? readConfig(root, "global", "user.name", env);
  const email = readConfig(root, "local", "user.email", env) ?? readConfig(root, "global", "user.email", env);
  if (!name || !email) {
    throw new Error("central repository Git user.name and user.email are required locally or globally");
  }
  return { name, email };
}
