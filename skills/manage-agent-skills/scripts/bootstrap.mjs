import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail, run } from "./install-helpers.mjs";

const runtimePaths = ["skills/manage-agent-skills", "src", "bin", "package.json", "package-lock.json", "tsconfig.json"];

function pathsChanged(root, from, to, paths) {
  const result = spawnSync("git", ["-C", root, "diff", "--quiet", from, to, "--", ...paths]);
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  fail(`git diff failed while comparing ${from} and ${to}`);
}

/**
 * A fresh clone leaves every vendor submodule uninitialized, and the Skills registered
 * from them have no `SKILL.md` on disk until it is. Git hooks cannot cover this because
 * hooks are never cloned, so the entry points repair it themselves.
 */
export function ensureSubmodules(root) {
  const status = spawnSync("git", ["-C", root, "submodule", "status"], { encoding: "utf8" });
  if (status.status !== 0) return false;
  if (!status.stdout.split("\n").some((line) => line.startsWith("-"))) return false;
  run("git", ["submodule", "update", "--init", "--recursive"], root);
  return true;
}

/**
 * Brings the central repository to a runnable `origin/main` before anything TypeScript
 * exists. There is no compiled output and `node_modules` may be absent, so this stage has
 * to be plain Node on a plain shell — it is the only code that can assume nothing.
 *
 * Returns `null` after re-executing the caller, which happens when the pull changed the
 * launcher or the manager itself; the caller should exit immediately in that case.
 */
export function prepareCentralRepository(scriptPath, argv) {
  const root = path.resolve(path.dirname(scriptPath), "../../..");
  if (!fs.existsSync(path.join(root, "registry", "skills.yaml"))) fail(`cannot locate central agent-skills repository from ${scriptPath}`);
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 20) fail("agent-skills requires Node.js 20 or newer");
  process.chdir(root);
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  if (run("git", ["status", "--porcelain"], root, { capture: true }) !== "") fail("central agent-skills repository has uncommitted changes");
  const initialHead = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  run("git", ["fetch", "origin"], root);
  run("git", ["switch", "main"], root);
  run("git", ["merge", "--ff-only", "origin/main"], root);
  const preparedHead = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  if (initialHead !== preparedHead && pathsChanged(root, initialHead, preparedHead, runtimePaths)) {
    if (!fs.existsSync(tsx) || pathsChanged(root, initialHead, preparedHead, ["package.json", "package-lock.json"])) run("npm", ["ci"], root);
    run(process.execPath, [scriptPath, ...argv], root);
    return null;
  }
  if (!fs.existsSync(tsx)) run("npm", ["ci"], root);
  ensureSubmodules(root);
  return { root, tsx };
}

/** Hands one mutating command to the manager's publishing path. */
export function publishArgs(title, operands, noPush) {
  const args = ["src/cli.ts", "publish", "--title", title];
  if (noPush) args.push("--no-push");
  return [...args, "--", ...operands];
}
