#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveGitIdentity } from "./git-identity.mjs";
import { changeCliArgs, changeMetadata, parseChangeArgs } from "./change-helpers.mjs";
import { fail, run, slug } from "./install-helpers.mjs";

function uniqueBranch(root, base) {
  const exists = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${base}`]).status === 0 ||
    spawnSync("git", ["-C", root, "ls-remote", "--exit-code", "--heads", "origin", base]).status === 0;
  if (!exists) return base;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${base}-${stamp}`;
}

function pathsChanged(root, from, to, paths) {
  const result = spawnSync("git", ["-C", root, "diff", "--quiet", from, to, "--", ...paths]);
  if (result.error) throw result.error;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  fail(`git diff failed while comparing ${from} and ${to}`);
}

function readJson(output) {
  try { return JSON.parse(output); } catch { fail(`manager returned invalid JSON: ${output}`); }
}

const values = parseChangeArgs(process.argv.slice(2));
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

const plan = readJson(run(tsx, changeCliArgs(values, true), root, { capture: true }));
const metadata = changeMetadata(values);
let branch = null;
let commit = null;
let pullRequest = null;
let identity = null;

if (plan.trackedChanges.length > 0) {
  run("gh", ["auth", "status"], root, { capture: true, message: "GitHub CLI is not authenticated" });
  identity = resolveGitIdentity(root);
  branch = uniqueBranch(root, metadata.branch.split("/").map(slug).join("/"));
  run("git", ["switch", "-c", branch], root);
}

const applied = plan.noOp ? plan : readJson(run(tsx, changeCliArgs(values, false), root, { capture: true }));

if (plan.trackedChanges.length > 0) {
  run("npm", ["run", "check"], root);
  run("npm", ["run", "build"], root);
  run("git", ["add", "-A", "--", ...plan.trackedChanges], root);
  const staged = run("git", ["diff", "--cached", "--name-only"], root, { capture: true });
  if (!staged) fail("change planned tracked changes but produced no staged diff");
  const allowed = new Set(plan.trackedChanges);
  const unexpected = staged.split("\n").filter((file) => !allowed.has(file));
  if (unexpected.length > 0) fail(`refusing to commit unexpected paths: ${unexpected.join(", ")}`);
  run("git", ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", metadata.title], root);
  commit = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  run("git", ["push", "-u", "origin", branch], root);
  const bodyPath = path.join(os.tmpdir(), `agent-skills-change-pr-${process.pid}.md`);
  const removed = applied.syncResult?.removed ?? [];
  const skipped = applied.syncResult?.skipped ?? [];
  fs.writeFileSync(bodyPath, `## Change\n\n- Action: \`${applied.action}\`\n- Skills: ${applied.skills.map((name) => `\`${name}\``).join(", ") || "none"}\n- Source: \`${applied.sourceId ?? "local"}\`\n- Source retained: \`${applied.retainedSource}\`\n- Planned links: ${applied.links.length}\n- Removed links: ${removed.length}\n- Skipped links: ${skipped.length}\n\n## Validation\n\n- \`npm run check\`\n- \`npm run build\`\n`);
  try {
    pullRequest = run("gh", ["pr", "create", "--draft", "--base", "main", "--head", branch, "--title", metadata.title, "--body-file", bodyPath], root, { capture: true });
  } finally {
    fs.rmSync(bodyPath, { force: true });
  }
}

console.log(JSON.stringify({ ...applied, branch, commit, pullRequest }, null, 2));
