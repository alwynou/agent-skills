#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeMetadata, changeOperands, parseChangeArgs } from "./change-helpers.mjs";
import { prepareCentralRepository, publishArgs } from "./bootstrap.mjs";
import { inferProjectId, run } from "./install-helpers.mjs";

const values = parseChangeArgs(process.argv.slice(2));
// Removing a project target should be as directory-aware as installing one, so derive
// the logical project ID the same way rather than making the caller look it up.
if (values.get("--scope") === "project" && !values.has("--project")) {
  values.set("--project", inferProjectId(path.resolve(values.get("--workdir") ?? process.cwd())));
}
const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));

const prepared = prepareCentralRepository(scriptPath, process.argv.slice(2));
if (prepared) {
  run(prepared.tsx, publishArgs(changeMetadata(values).title, changeOperands(values), values.has("--no-push")), prepared.root);
}
