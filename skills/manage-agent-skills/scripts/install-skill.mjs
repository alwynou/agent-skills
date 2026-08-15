#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCentralRepository, publishArgs } from "./bootstrap.mjs";
import { fail, installOperands, parseArgs, run } from "./install-helpers.mjs";

const values = parseArgs(process.argv.slice(2));
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const cwd = path.resolve(values.get("--workdir") ?? process.cwd());
if (!fs.statSync(cwd).isDirectory()) fail(`working directory is not a directory: ${cwd}`);

const prepared = prepareCentralRepository(scriptPath, process.argv.slice(2));
if (prepared) {
  const title = `feat(skills): 添加 ${values.get("--skill")} skill (${values.get("--source-url")})`;
  run(prepared.tsx, publishArgs(title, installOperands(values, cwd), values.has("--no-push")), prepared.root);
}
