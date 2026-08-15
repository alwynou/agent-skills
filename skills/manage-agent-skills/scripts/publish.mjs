import { spawnSync } from "node:child_process";
import { resolveGitIdentity } from "./git-identity.mjs";
import { fail, run } from "./install-helpers.mjs";

const runtimePrefixes = ["src/", "bin/", "tests/", "skills/manage-agent-skills/"];
const runtimeFiles = new Set(["package.json", "package-lock.json", "tsconfig.json"]);

export function readJson(output) {
  try { return JSON.parse(output); } catch { fail(`manager returned invalid JSON: ${output}`); }
}

export function touchesRuntime(trackedChanges) {
  return trackedChanges.some((file) => runtimeFiles.has(file) || runtimePrefixes.some((prefix) => file.startsWith(prefix)));
}

// Registry, lock, and vendor edits cannot break the build, so they only need to prove
// that the registry still parses. Runtime edits keep the full check and build.
function validate(root, tsx, trackedChanges) {
  if (!touchesRuntime(trackedChanges)) {
    run(tsx, ["src/cli.ts", "list"], root, { capture: true, message: "registry no longer resolves after the change" });
    return "registry";
  }
  run("npm", ["run", "check"], root);
  run("npm", ["run", "build"], root);
  return "full";
}

// `git add -A -- <path>` fails when a planned path matches nothing in the worktree or
// index, which happens once the manager has already removed a deleted submodule gitlink.
// The staged-diff comparison below is what actually proves the commit is complete.
function stage(root, trackedChanges) {
  for (const target of trackedChanges) {
    const result = spawnSync("git", ["-C", root, "add", "-A", "--", target], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 0) continue;
    const details = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    if (details.includes("did not match any files")) continue;
    fail(details ? `git add failed for ${target}:\n${details}` : `git add failed for ${target}`);
  }
}

function restore(root, revision, trackedChanges) {
  for (const target of trackedChanges) {
    spawnSync("git", ["-C", root, "restore", "--source", revision, "--staged", "--worktree", "--", target], { encoding: "utf8" });
  }
  spawnSync("git", ["-C", root, "submodule", "update", "--init", "--recursive"], { encoding: "utf8" });
  return (spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).stdout ?? "").trim();
}

/**
 * Applies the change to the central repository's registry, commits it on main, then
 * reconciles the symlinks. Nothing is branched and no pull request is opened: the
 * central repository is the user's own configuration, so main is the only branch that
 * ever needs to reflect it. Links are synchronized after the commit so a failed
 * validation leaves the machine untouched and rolls back to a clean main.
 */
export function commitOnMain({ root, tsx, plan, title, applyArgs, syncArgs, push }) {
  const identity = resolveGitIdentity(root);
  const revision = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  let applied;
  let validation;
  try {
    applied = readJson(run(tsx, applyArgs, root, { capture: true }));
    validation = validate(root, tsx, plan.trackedChanges);
    stage(root, plan.trackedChanges);
    const staged = run("git", ["diff", "--cached", "--name-only"], root, { capture: true });
    if (!staged) fail("change planned tracked changes but produced no staged diff");
    const allowed = new Set(plan.trackedChanges);
    const unexpected = staged.split("\n").filter((file) => !allowed.has(file));
    if (unexpected.length > 0) fail(`refusing to commit unexpected paths: ${unexpected.join(", ")}`);
    run("git", ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", title], root);
  } catch (error) {
    const residual = restore(root, revision, plan.trackedChanges);
    const suffix = residual
      ? `\ncentral repository still has uncommitted changes; resolve them before retrying:\n${residual}`
      : "\ncentral repository was restored to a clean main; no links were touched.";
    throw new Error(`${error.message}${suffix}`);
  }
  const commit = run("git", ["rev-parse", "HEAD"], root, { capture: true });
  const syncOutput = run(tsx, syncArgs, root, { capture: true });
  let pushed = false;
  let pushError = null;
  if (push) {
    const result = spawnSync("git", ["-C", root, "push", "origin", "main"], { encoding: "utf8" });
    pushed = result.status === 0;
    if (!pushed) pushError = `${result.stderr ?? ""}`.trim() || "git push origin main failed";
  }
  return { ...applied, validation, commit, syncOutput, pushed, pushError };
}
