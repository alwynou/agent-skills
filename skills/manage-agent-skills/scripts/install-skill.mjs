#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCentralRepository, publishArgs } from "./bootstrap.mjs";
import { fail, installOperands, installTitle, parseArgs, run, succeeds } from "./install-helpers.mjs";

const values = parseArgs(process.argv.slice(2));
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const cwd = path.resolve(values.get("--workdir") ?? process.cwd());
if (!fs.statSync(cwd).isDirectory()) fail(`working directory is not a directory: ${cwd}`);

const prepared = prepareCentralRepository(scriptPath, process.argv.slice(2));
if (prepared) {
  // `show` is read-only and hits no network, so asking costs one startup and keeps the
  // commit message honest about whether this adds a Skill or adjusts an existing one.
  const registered = succeeds(prepared.tsx, ["src/cli.ts", "show", values.get("--skill"), "--json"], prepared.root);
  const title = installTitle(values, registered);
  run(prepared.tsx, publishArgs(title, installOperands(values, cwd), values.has("--no-push")), prepared.root);
}
