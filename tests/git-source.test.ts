import { describe, expect, it } from "vitest";
import { GitSource } from "../src/sources/git-source.js";
import type { GitPort } from "../src/git/client.js";

class FakeGit implements GitPort {
  calls: string[][] = [];
  async run(_cwd: string, args: string[]): Promise<string> {
    this.calls.push(args);
    const joined = args.join(" ");
    if (joined === "rev-parse HEAD") return "aaa";
    if (joined === "rev-parse origin/HEAD") return "bbb";
    if (joined.startsWith("rev-list")) return "3";
    return "";
  }
}

describe("GitSource", () => {
  it("fetches without changing the working tree during check", async () => {
    const git = new FakeGit();
    const source = new GitSource("vendor", { type: "git", repo: "https://example.com/vendor.git" }, "/repo/vendors", git);
    const info = await source.check("aaa");
    expect(info).toMatchObject({ current: "aaa", candidate: "bbb", behind: 3 });
    expect(git.calls).toContainEqual(["fetch", "--quiet", "origin"]);
    expect(git.calls.some((args) => args.includes("checkout"))).toBe(false);
  });
});
