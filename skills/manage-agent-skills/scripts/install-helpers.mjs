import path from "node:path";
import { spawnSync } from "node:child_process";

export function fail(message) {
  throw new Error(message);
}

export function run(command, args, cwd, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const summary = options.message ?? `${command} ${args[0] ?? ""} failed`;
    const details = capture
      ? [result.stderr, result.stdout].map((value) => value?.trim()).filter(Boolean).join("\n")
      : "";
    fail(details ? `${summary}:\n${details}` : summary);
  }
  return (result.stdout ?? "").trim();
}

export function parseArgs(argv) {
  const allowed = new Set([
    "--skill", "--source-url", "--scope", "--agents", "--workdir", "--project",
    "--repo", "--source-id", "--path", "--ref",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unexpected positional argument ${name ?? "<end>"}`);
    if (values.has(name)) fail(`duplicate argument ${name}`);
    if (name === "--no-push") {
      values.set(name, "true");
      index += 1;
      continue;
    }
    if (!allowed.has(name)) fail(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values.set(name, value);
    index += 2;
  }
  for (const required of ["--skill", "--source-url", "--scope"]) if (!values.has(required)) fail(`${required} is required`);
  const scope = values.get("--scope");
  if (!["global", "project"].includes(scope)) fail("--scope must be global or project");
  if (scope === "global" && !values.has("--agents")) fail("--agents is required for global scope");
  return values;
}

export function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function projectIdFromRemote(remoteUrl) {
  const value = remoteUrl.trim().replace(/\.git$/i, "");
  let pathname = "";
  try {
    const parsed = new URL(value);
    if (["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) pathname = parsed.pathname;
  } catch {
    const scpLike = value.match(/^[^/\s]+@[^/:\s]+:(.+)$/);
    if (scpLike) pathname = scpLike[1];
  }
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const identifier = slug(`${segments.at(-2)}-${segments.at(-1)}`);
  return identifier || null;
}

export function inferProjectId(cwd) {
  const remote = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (remote.status === 0) {
    const identifier = projectIdFromRemote(remote.stdout);
    if (identifier) return identifier;
  }
  return slug(path.basename(cwd));
}

/**
 * Builds the manager's `install` operands. The launcher deliberately speaks the manager's
 * own vocabulary, so this only supplies what the manager cannot know: the working
 * directory behind a project install and its inferred logical ID.
 */
export function installOperands(values, cwd) {
  const scope = values.get("--scope");
  const operands = ["install", values.get("--skill"), "--scope", scope];
  operands.push("--agents", values.get("--agents") ?? "*");
  for (const name of ["--repo", "--source-id", "--path", "--ref"]) {
    if (values.has(name)) operands.push(name, values.get(name));
  }
  if (scope === "project") {
    operands.push("--project", values.get("--project") ?? inferProjectId(cwd));
    operands.push("--project-path", cwd);
  }
  return operands;
}
