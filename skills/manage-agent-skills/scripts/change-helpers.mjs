import { fail } from "./install-helpers.mjs";

export function parseChangeArgs(argv) {
  const allowed = new Set(["--action", "--skill", "--source", "--scope", "--agent", "--project", "--workdir"]);
  const values = new Map();
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (!name?.startsWith("--")) fail(`unexpected positional argument ${name ?? "<end>"}`);
    if (!allowed.has(name)) fail(`unknown argument ${name}`);
    if (values.has(name)) fail(`duplicate argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values.set(name, value);
    index += 2;
  }

  const action = values.get("--action");
  if (!action || !["remove", "delete", "delete-source"].includes(action)) {
    fail("--action must be remove, delete, or delete-source");
  }
  if (action === "remove") {
    if (!values.has("--skill")) fail("--skill is required for remove");
    if (values.has("--source")) fail("--source is only allowed for delete-source");
    const scope = values.get("--scope");
    if (!scope || !["project", "agent-global", "all-global", "all"].includes(scope)) {
      fail("remove --scope must be project, agent-global, all-global, or all");
    }
    if (scope === "agent-global" && !values.has("--agent")) fail("--agent is required for agent-global removal");
    if (scope !== "agent-global" && values.has("--agent")) fail("--agent is only allowed for agent-global removal");
    if (scope === "project" && !values.has("--project")) fail("--project is required for project removal");
    if (scope !== "project" && values.has("--project")) fail("--project is only allowed for project removal");
  } else if (action === "delete") {
    if (!values.has("--skill")) fail("--skill is required for delete");
    for (const name of ["--source", "--scope", "--agent", "--project"]) {
      if (values.has(name)) fail(`${name} is not allowed for delete`);
    }
  } else {
    if (!values.has("--source")) fail("--source is required for delete-source");
    for (const name of ["--skill", "--scope", "--agent", "--project"]) {
      if (values.has(name)) fail(`${name} is not allowed for delete-source`);
    }
  }
  return values;
}

export function changeCliArgs(values, dryRun) {
  const action = values.get("--action");
  let args;
  if (action === "remove") {
    args = ["src/cli.ts", "remove", values.get("--skill")];
    const scope = values.get("--scope");
    if (scope === "all") args.push("--all");
    else if (scope === "project") args.push("--scope", "project", "--project", values.get("--project"));
    else args.push("--scope", "global", "--agents", scope === "agent-global" ? values.get("--agent") : "*");
  } else if (action === "delete") {
    args = ["src/cli.ts", "delete", values.get("--skill")];
  } else {
    args = ["src/cli.ts", "delete", "--source", values.get("--source")];
  }
  if (dryRun) args.push("--dry-run", "--no-sync");
  args.push("--json");
  return args;
}

export function changeMetadata(values) {
  const action = values.get("--action");
  if (action === "remove") {
    const skill = values.get("--skill");
    const scope = values.get("--scope");
    return {
      branch: `skills/remove-${skill}-${scope}`,
      title: `chore(skills): 移除 ${skill} 的 ${scope} 安装`,
    };
  }
  if (action === "delete") {
    const skill = values.get("--skill");
    return { branch: `skills/delete-${skill}`, title: `chore(skills): 删除 ${skill} skill` };
  }
  const source = values.get("--source");
  return {
    branch: `skills/delete-source-${source}`,
    title: `chore(skills): 删除 ${source} source 及其 Skills`,
  };
}
