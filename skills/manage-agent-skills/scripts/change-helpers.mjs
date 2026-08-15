import { fail } from "./install-helpers.mjs";

const actions = ["remove", "delete", "update", "enable", "disable"];

export function parseChangeArgs(argv) {
  const allowed = new Set(["--action", "--skill", "--source", "--scope", "--agents", "--project", "--workdir"]);
  const flags = new Set(["--all", "--no-push"]);
  const values = new Map();
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unexpected positional argument ${name ?? "<end>"}`);
    if (values.has(name)) fail(`duplicate argument ${name}`);
    if (flags.has(name)) {
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

  const action = values.get("--action");
  if (!action || !actions.includes(action)) fail(`--action must be ${actions.join(", ")}`);
  const reject = (names) => {
    for (const name of names) if (values.has(name)) fail(`${name} is not allowed for ${action}`);
  };

  if (action === "remove") {
    if (!values.has("--skill")) fail("--skill is required for remove");
    reject(["--source"]);
    if (values.has("--all")) {
      reject(["--scope", "--agents", "--project"]);
      return values;
    }
    const scope = values.get("--scope");
    if (!scope || !["global", "project"].includes(scope)) fail("remove requires --all or --scope global|project");
    if (scope === "global" && !values.has("--agents")) fail("--agents is required for global removal");
    if (scope === "global" && values.has("--project")) fail("--project is only allowed for project removal");
    // --project may be omitted; the launcher infers it from the working directory.
    if (scope === "project" && values.has("--agents")) fail("--agents is not allowed for project removal");
  } else if (action === "delete") {
    if (values.has("--skill") === values.has("--source")) fail("delete requires exactly one of --skill or --source");
    reject(["--scope", "--agents", "--project", "--all"]);
  } else if (action === "update") {
    if (!values.has("--source")) fail("--source is required for update");
    reject(["--skill", "--scope", "--agents", "--project", "--all"]);
  } else {
    if (!values.has("--skill")) fail(`--skill is required for ${action}`);
    reject(["--source", "--scope", "--agents", "--project", "--all"]);
  }
  return values;
}

/**
 * Rearranges the launcher's flags into the manager's operands. The two speak the same
 * vocabulary, so this stays a rearrangement rather than a translation.
 */
export function changeOperands(values) {
  const action = values.get("--action");
  if (action === "remove") {
    const operands = ["remove", values.get("--skill")];
    if (values.has("--all")) return [...operands, "--all"];
    const scope = values.get("--scope");
    if (scope === "project") return [...operands, "--scope", "project", "--project", values.get("--project")];
    return [...operands, "--scope", "global", "--agents", values.get("--agents")];
  }
  if (action === "delete") {
    return values.has("--source") ? ["delete", "--source", values.get("--source")] : ["delete", values.get("--skill")];
  }
  if (action === "update") return ["update", values.get("--source")];
  return [action, values.get("--skill")];
}

export function changeMetadata(values) {
  const action = values.get("--action");
  const skill = values.get("--skill");
  if (action === "remove") {
    const scope = values.has("--all") ? "全部" : values.get("--scope");
    return { title: `chore(skills): 移除 ${skill} 的 ${scope} 安装` };
  }
  if (action === "delete") {
    return values.has("--source")
      ? { title: `chore(skills): 删除 ${values.get("--source")} source 及其 Skills` }
      : { title: `chore(skills): 删除 ${skill} skill` };
  }
  if (action === "update") return { title: `chore(skills): 更新 ${values.get("--source")} source` };
  return { title: `chore(skills): ${action === "enable" ? "启用" : "停用"} ${skill} skill` };
}
