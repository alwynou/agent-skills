import path from "node:path";

export interface ProjectPaths {
  root: string;
  registry: string;
  lock: string;
  managedLinks: string;
  vendors: string;
}

export function projectPaths(root: string): ProjectPaths {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    registry: path.join(absoluteRoot, "registry", "skills.yaml"),
    lock: path.join(absoluteRoot, ".skill-manager", "lock.yaml"),
    managedLinks: path.join(absoluteRoot, ".skill-manager", "managed-links.json"),
    vendors: path.join(absoluteRoot, "vendors"),
  };
}
