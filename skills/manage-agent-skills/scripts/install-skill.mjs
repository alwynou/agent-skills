#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveGitIdentity } from "./git-identity.mjs";
import { fail, inferProjectId, parseArgs, run, slug } from "./install-helpers.mjs";

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

function cliArgs(values, cwd, dryRun) {
  const scope = values.get("--scope");
  const args = ["src/cli.ts", "install", values.get("--skill")];
  args.push("--scope", scope === "project" ? "project" : "global");
  args.push("--agents", scope === "agent-global" ? values.get("--agent") : "*");
  for (const [input, output] of [["--repo", "--repo"], ["--source-id", "--source-id"], ["--path", "--path"], ["--ref", "--ref"]]) {
    if (values.has(input)) args.push(output, values.get(input));
  }
  if (scope === "project") {
    args.push("--project", values.get("--project") ?? inferProjectId(cwd));
    args.push("--project-path", cwd);
  }
  if (dryRun) args.push("--dry-run", "--no-sync");
  args.push("--json");
  return args;
}

function readJson(output) {
  try { return JSON.parse(output); } catch { fail(`manager returned invalid JSON: ${output}`); }
}

const values = parseArgs(process.argv.slice(2));
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const root = path.resolve(path.dirname(scriptPath), "../../..");
const invocationDirectory = process.cwd();
const cwd = path.resolve(values.get("--workdir") ?? invocationDirectory);
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

const plan = readJson(run(tsx, cliArgs(values, cwd, true), root, { capture: true }));
const title = `feat(skills): 添加 ${values.get("--skill")} skill (${values.get("--source-url")})`;
let branch = null;
let commit = null;
let pullRequest = null;
let identity = null;

if (plan.trackedChanges.length > 0) {
  run("gh", ["auth", "status"], root, { capture: true, message: "GitHub CLI is not authenticated" });
  identity = resolveGitIdentity(root);
  branch = uniqueBranch(root, `skills/install-${slug(values.get("--skill"))}-${slug(values.get("--scope"))}`);
  run("git", ["switch", "-c", branch], root);
}

const applied = readJson(run(tsx, cliArgs(values, cwd, false), root, { capture: true }));

if (plan.trackedChanges.length > 0) {
  run("npm", ["run", "check"], root);
  run("npm", ["run", "build"], root);
  run("git", ["add", "--", ...plan.trackedChanges], root);
  const staged = run("git", ["diff", "--cached", "--name-only"], root, { capture: true });
  if (!staged) fail("installation planned tracked changes but produced no staged diff");
  const allowed = new Set(plan.trackedChanges);
  const unexpected = staged.split("\n").filter((file) => !allowed.has(file));
  if (unexpected.length > 0) fail(`refusing to commit unexpected paths: ${unexpected.join(", ")}`);
  run("git", ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", title], root);
  commit = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  run("git", ["push", "-u", "origin", branch], root);
  const bodyPath = path.join(os.tmpdir(), `agent-skills-pr-${process.pid}.md`);
  fs.writeFileSync(bodyPath, `## Skill\n\n- Name: \`${values.get("--skill")}\`\n- Source: ${values.get("--source-url")}\n- Locked commit: \`${applied.source.commit ?? "local"}\`\n- Scope: \`${values.get("--scope")}\`\n\n## Validation\n\n- \`npm run check\`\n- \`npm run build\`\n`);
  try {
    pullRequest = run("gh", ["pr", "create", "--draft", "--base", "main", "--head", branch, "--title", title, "--body-file", bodyPath], root, { capture: true });
  } finally {
    fs.rmSync(bodyPath, { force: true });
  }
}

console.log(JSON.stringify({ ...applied, branch, commit, pullRequest }, null, 2));
