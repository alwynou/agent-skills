#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { changeCliArgs, changeMetadata, changeSyncArgs, parseChangeArgs } from "./change-helpers.mjs";
import { commitOnMain, readJson } from "./publish.mjs";
import { fail, inferProjectId, run } from "./install-helpers.mjs";

function pathsChanged(root, from, to, paths) {
  const result = spawnSync("git", ["-C", root, "diff", "--quiet", from, to, "--", ...paths]);
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  fail(`git diff failed while comparing ${from} and ${to}`);
}

const values = parseChangeArgs(process.argv.slice(2));
// Removing a project target should be as directory-aware as installing one, so derive
// the logical project ID the same way rather than making the caller look it up.
if (values.get("--scope") === "project" && !values.has("--project")) {
  values.set("--project", inferProjectId(path.resolve(values.get("--workdir") ?? process.cwd())));
}
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
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
const runtimePaths = ["skills/manage-agent-skills", "src", "bin", "package.json", "package-lock.json", "tsconfig.json"];
if (initialHead !== preparedHead && pathsChanged(root, initialHead, preparedHead, runtimePaths)) {
  if (!fs.existsSync(tsx) || pathsChanged(root, initialHead, preparedHead, ["package.json", "package-lock.json"])) run("npm", ["ci"], root);
  run(process.execPath, [scriptPath, ...process.argv.slice(2)], root);
  process.exit(0);
}
if (!fs.existsSync(tsx)) run("npm", ["ci"], root);

const plan = readJson(run(tsx, changeCliArgs(values, { dryRun: true }), root, { capture: true }));

// Nothing tracked to record: the change only rebinds local link state, so apply it
// directly and leave main alone.
if (plan.trackedChanges.length === 0) {
  const applied = plan.noOp ? plan : readJson(run(tsx, changeCliArgs(values), root, { capture: true }));
  console.log(JSON.stringify({ ...applied, commit: null, pushed: false }, null, 2));
  process.exit(0);
}

const result = commitOnMain({
  root,
  tsx,
  plan,
  title: changeMetadata(values).title,
  applyArgs: changeCliArgs(values, { sync: false }),
  syncArgs: changeSyncArgs(),
  push: !values.has("--no-push"),
});

console.log(JSON.stringify(result, null, 2));
if (result.pushError) console.warn(`warning: committed on main but not pushed: ${result.pushError}`);
