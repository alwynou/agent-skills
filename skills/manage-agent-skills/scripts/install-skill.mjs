#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveGitIdentity } from "./git-identity.mjs";

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(options.message ?? `${command} ${args[0] ?? ""} failed`);
  return (result.stdout ?? "").trim();
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) fail(`invalid argument near ${name ?? "<end>"}`);
    values.set(name, value);
  }
  for (const required of ["--skill", "--source-url", "--scope"]) if (!values.has(required)) fail(`${required} is required`);
  const scope = values.get("--scope");
  if (!["project", "agent-global", "all-global"].includes(scope)) fail("--scope must be project, agent-global, or all-global");
  if (scope !== "all-global" && !values.has("--agent")) fail("--agent is required for project and agent-global scope");
  return values;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function inferProjectId(cwd) {
  const remote = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (remote.status === 0) {
    const match = remote.stdout.trim().match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (match) return slug(`${match[1]}-${match[2]}`);
  }
  return slug(path.basename(cwd));
}

function uniqueBranch(root, base) {
  const exists = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${base}`]).status === 0 ||
    spawnSync("git", ["-C", root, "ls-remote", "--exit-code", "--heads", "origin", base]).status === 0;
  if (!exists) return base;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${base}-${stamp}`;
}

function cliArgs(values, cwd, dryRun) {
  const scope = values.get("--scope");
  const args = ["src/cli.ts", "install", values.get("--skill")];
  args.push("--scope", scope === "project" ? "project" : "global");
  args.push("--agents", scope === "all-global" ? "*" : values.get("--agent"));
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
if (!fs.existsSync(tsx)) run("npm", ["ci"], root);
if (run("git", ["status", "--porcelain"], root, { capture: true }) !== "") fail("central agent-skills repository has uncommitted changes");
run("git", ["fetch", "origin"], root);
run("git", ["switch", "main"], root);
run("git", ["merge", "--ff-only", "origin/main"], root);

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
