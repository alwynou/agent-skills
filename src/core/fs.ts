import fs from "node:fs/promises";

export interface FsPort {
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export class NodeFs implements FsPort {
  async lstat(filePath: string) {
    return fs.lstat(filePath);
  }

  async mkdir(directory: string) {
    await fs.mkdir(directory, { recursive: true });
  }

  async readFile(filePath: string) {
    return fs.readFile(filePath, "utf8");
  }

  async readlink(filePath: string) {
    return fs.readlink(filePath);
  }

  async realpath(filePath: string) {
    return fs.realpath(filePath);
  }

  async rename(from: string, to: string) {
    await fs.rename(from, to);
  }

  async symlink(target: string, filePath: string) {
    await fs.symlink(target, filePath, "dir");
  }

  async unlink(filePath: string) {
    await fs.unlink(filePath);
  }

  async writeFile(filePath: string, content: string) {
    await fs.writeFile(filePath, content, "utf8");
  }
}

export async function pathExists(fsPort: FsPort, filePath: string): Promise<boolean> {
  try {
    await fsPort.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function atomicWrite(fsPort: FsPort, filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fsPort.writeFile(tempPath, content);
  await fsPort.rename(tempPath, filePath);
}
