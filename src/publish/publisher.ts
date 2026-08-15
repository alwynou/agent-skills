import { UserError } from "../core/errors.js";
import type { SyncResultSummary } from "../core/types.js";
import type { MutationPlan } from "../command/mutations.js";
import type { CommandPort } from "./process.js";

const runtimePrefixes = ["src/", "tests/", "skills/manage-agent-skills/"];
const runtimeFiles = new Set(["package.json", "package-lock.json", "tsconfig.json"]);

export type Validation = "registry" | "full";

export interface PublishResult {
  plan: MutationPlan;
  validation: Validation | null;
  commit: string | null;
  syncResult: SyncResultSummary | null;
  pushed: boolean;
  pushError: string | null;
}

export interface PublishRequest {
  root: string;
  title: string;
  push: boolean;
  /** Runs the mutation. `sync: false` records committed state without touching links. */
  apply(options: { dryRun: boolean; sync: boolean }): Promise<MutationPlan>;
  /** Reconciles symlinks once the commit exists. */
  sync(): Promise<SyncResultSummary>;
}

/** Registry, lock, and vendor edits cannot break the build; runtime edits can. */
export function touchesRuntime(trackedChanges: readonly string[]): boolean {
  return trackedChanges.some((file) => runtimeFiles.has(file) || runtimePrefixes.some((prefix) => file.startsWith(prefix)));
}

async function git(commands: CommandPort, root: string, args: string[]): Promise<string> {
  const result = await commands.run("git", args, root);
  if (result.status !== 0) throw new UserError(`git ${args[0] ?? "command"} failed: ${result.stderr || `exit ${result.status}`}`);
  return result.stdout;
}

async function validate(commands: CommandPort, root: string, trackedChanges: readonly string[]): Promise<Validation> {
  if (!touchesRuntime(trackedChanges)) return "registry";
  // There is no build step: the Skill runs the TypeScript sources directly, so type
  // checking and tests are the whole of validation.
  const result = await commands.run("npm", ["run", "check"], root);
  if (result.status !== 0) throw new UserError(`npm run check failed: ${result.stderr || result.stdout}`);
  return "full";
}

/**
 * `git add -A -- <path>` fails when a planned path matches nothing in the worktree or
 * index, which happens once the manager has already removed a deleted submodule gitlink.
 * The staged-diff comparison below is what actually proves the commit is complete.
 */
async function stage(commands: CommandPort, root: string, trackedChanges: readonly string[]): Promise<void> {
  for (const target of trackedChanges) {
    const result = await commands.run("git", ["add", "-A", "--", target], root);
    if (result.status === 0) continue;
    if (result.stderr.includes("did not match any files")) continue;
    throw new UserError(`git add failed for ${target}: ${result.stderr || `exit ${result.status}`}`);
  }
}

async function restore(commands: CommandPort, root: string, revision: string, trackedChanges: readonly string[]): Promise<string> {
  for (const target of trackedChanges) {
    await commands.run("git", ["restore", "--source", revision, "--staged", "--worktree", "--", target], root);
  }
  await commands.run("git", ["submodule", "update", "--init", "--recursive"], root);
  return (await commands.run("git", ["status", "--porcelain"], root)).stdout;
}

async function identity(commands: CommandPort, root: string): Promise<{ name: string; email: string }> {
  const read = async (key: string): Promise<string | null> => {
    for (const scope of ["--local", "--global"]) {
      const result = await commands.run("git", ["config", scope, "--get", key], root);
      if (result.status === 0 && result.stdout) return result.stdout;
    }
    return null;
  };
  const name = await read("user.name");
  const email = await read("user.email");
  if (!name || !email) throw new UserError("central repository Git user.name and user.email are required locally or globally");
  return { name, email };
}

/**
 * Applies a mutation's committed state, records it on `main`, and only then reconciles
 * the symlinks. Nothing is branched and no pull request is opened: the central
 * repository is the user's own configuration, so `main` is the only branch that ever
 * represents it. Ordering the commit before the links is what makes a failed run
 * recoverable — validation failures leave the machine untouched and restore a clean
 * `main` instead of stranding half-applied state.
 */
export async function publish(commands: CommandPort, request: PublishRequest): Promise<PublishResult> {
  const { root } = request;
  if ((await git(commands, root, ["status", "--porcelain"])) !== "") {
    throw new UserError("central agent-skills repository has uncommitted changes");
  }
  const planned = await request.apply({ dryRun: true, sync: false });
  if (planned.trackedChanges.length === 0) {
    // Only local link or binding state changes; apply it and leave main alone.
    const applied = planned.noOp ? planned : await request.apply({ dryRun: false, sync: true });
    return { plan: applied, validation: null, commit: null, syncResult: null, pushed: false, pushError: null };
  }

  const who = await identity(commands, root);
  const revision = await git(commands, root, ["rev-parse", "HEAD"]);
  let plan: MutationPlan;
  let validation: Validation;
  try {
    plan = await request.apply({ dryRun: false, sync: false });
    validation = await validate(commands, root, planned.trackedChanges);
    await stage(commands, root, planned.trackedChanges);
    const staged = await git(commands, root, ["diff", "--cached", "--name-only"]);
    if (!staged) throw new UserError("change planned tracked changes but produced no staged diff");
    const allowed = new Set(planned.trackedChanges);
    const unexpected = staged.split("\n").filter((file) => !allowed.has(file));
    if (unexpected.length > 0) throw new UserError(`refusing to commit unexpected paths: ${unexpected.join(", ")}`);
    await git(commands, root, ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "commit", "-m", request.title]);
  } catch (error) {
    const residual = await restore(commands, root, revision, planned.trackedChanges);
    const suffix = residual
      ? `\ncentral repository still has uncommitted changes; resolve them before retrying:\n${residual}`
      : "\ncentral repository was restored to a clean main; no links were touched.";
    throw new UserError(`${(error as Error).message}${suffix}`);
  }

  const commit = await git(commands, root, ["rev-parse", "HEAD"]);
  const syncResult = await request.sync();
  let pushed = false;
  let pushError: string | null = null;
  if (request.push) {
    const result = await commands.run("git", ["push", "origin", "main"], root);
    pushed = result.status === 0;
    if (!pushed) pushError = result.stderr || "git push origin main failed";
  }
  return { plan, validation, commit, syncResult, pushed, pushError };
}
