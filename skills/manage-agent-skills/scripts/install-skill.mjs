#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commitOnMain, readJson } from "./publish.mjs";
import { fail, inferProjectId, parseArgs, run } from "./install-helpers.mjs";

function pathsChanged(root, from, to, paths) {
  const result = spawnSync("git", ["-C", root, "diff", "--quiet", from, to, "--", ...paths]);
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  fail(`git diff failed while comparing ${from} and ${to}`);
}

function cliArgs(values, cwd, { dryRun = false, sync = true } = {}) {
  const scope = values.get("--scope");
  const args = ["src/cli.ts", "install", values.get("--skill")];
  args.push("--scope", scope === "project" ? "project" : "global");
  // `--agent` narrows either an agent-global install or a project install to one agent.
  args.push("--agents", values.get("--agent") ?? "*");
  for (const name of ["--repo", "--source-id", "--path", "--ref"]) {
    if (values.has(name)) args.push(name, values.get(name));
  }
  if (scope === "project") {
    args.push("--project", values.get("--project") ?? inferProjectId(cwd));
    args.push("--project-path", cwd);
  }
  if (dryRun) args.push("--dry-run");
  if (dryRun || !sync) args.push("--no-sync");
  args.push("--json");
  return args;
}

const values = parseArgs(process.argv.slice(2));
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(scriptPath), "../../..");
const cwd = path.resolve(values.get("--workdir") ?? process.cwd());
if (!fs.existsSync(path.join(root, "registry", "skills.yaml"))) fail(`cannot locate central agent-skills repository from ${scriptPath}`);
if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 20) fail("agent-skills requires Node.js 20 or newer");
if (!fs.statSync(cwd).isDirectory()) fail(`working directory is not a directory: ${cwd}`);
process.chdir(root);
const tsx = path.join(root, "node_modules", ".bin", "tsx");
if (run("git", ["status", "--porcelain"], root, { capture: true }) !== "") fail("central agent-skills repository has uncommitted changes");
const initialHead = run("git", ["rev-parse", "HEAD"], root, { capture: true });
run("git", ["fetch", "origin"], root);
run("git", ["switch", "main"], root);
run("git", ["merge", "--ff-only", "origin/main"], root);
const preparedHead = run("git", ["rev-parse", "HEAD"], root, { capture: true });
const runtimePaths = ["skills/manage-agent-skills", "src", "bin", "package.json", "package-lock.json", "tsconfig.json"];
if (initialHead !== preparedHead && pathsChanged(root, initialHead, preparedHead, runtimePaths)) {
  if (!fs.existsSync(tsx) || pathsChanged(root, initialHead, preparedHead, ["package.json", "package-lock.json"])) {
    run("npm", ["ci"], root);
  }
  run(process.execPath, [scriptPath, ...process.argv.slice(2)], root);
  process.exit(0);
}
if (!fs.existsSync(tsx)) run("npm", ["ci"], root);

const plan = readJson(run(tsx, cliArgs(values, cwd, { dryRun: true }), root, { capture: true }));

// Nothing tracked to record: the Skill is already registered and only its local link
// bindings change, so apply it directly and leave main alone.
if (plan.trackedChanges.length === 0) {
  const applied = readJson(run(tsx, cliArgs(values, cwd), root, { capture: true }));
  console.log(JSON.stringify({ ...applied, commit: null, pushed: false }, null, 2));
  process.exit(0);
}

const result = commitOnMain({
  root,
  tsx,
  plan,
  title: `feat(skills): 添加 ${values.get("--skill")} skill (${values.get("--source-url")})`,
  applyArgs: cliArgs(values, cwd, { sync: false }),
  syncArgs: ["src/cli.ts", "sync", "--skill", values.get("--skill")],
  push: !values.has("--no-push"),
});

console.log(JSON.stringify(result, null, 2));
if (result.pushError) console.warn(`warning: committed on main but not pushed: ${result.pushError}`);
