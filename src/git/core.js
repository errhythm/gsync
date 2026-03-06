import { execSync } from "child_process";
import { join, dirname } from "path";

import { execAsync } from "../utils/exec.js";

export function findRepos(cwd, depth) {
  try {
    const out = execSync(
      `find . -mindepth 1 -maxdepth ${depth} -type d -name '.git' 2>/dev/null`,
      { cwd, encoding: "utf8" },
    );
    const repos = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((g) => join(cwd, dirname(g)));

    // Filter out repos nested inside another found repo (submodule / monorepo protection).
    // A repo is nested if any other repo path is a strict path prefix of it.
    return repos.filter(
      (repo) => !repos.some(
        (other) => other !== repo && repo.startsWith(other + "/"),
      ),
    );
  } catch {
    return [];
  }
}

export async function getCurrentBranch(repoPath) {
  try {
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

export async function getRepoStatus(repoPath) {
  try {
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
    });
    const lines = stdout.trim().split("\n").filter(Boolean);
    return { dirty: lines.length > 0, count: lines.length };
  } catch {
    return { dirty: false, count: 0 };
  }
}

export async function getAheadBehind(repoPath) {
  try {
    const { stdout } = await execAsync(
      "git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null",
      { cwd: repoPath, encoding: "utf8" },
    );
    if (!stdout.trim()) return { ahead: 0, behind: 0 };
    const [behind, ahead] = stdout.trim().split("\t").map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
