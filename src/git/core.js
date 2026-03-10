import { readdirSync, statSync } from "fs";
import { join, dirname, sep } from "path";

import { execAsync } from "../utils/exec.js";

export function findRepos(cwd, depth) {
  const repos = [];

  function walk(dir, currentDepth) {
    if (currentDepth > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or unreadable — skip
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === ".git") {
        repos.push(dirname(full));
        return; // don't recurse into .git itself
      }
      // Skip hidden dirs (other than .git above) and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walk(full, currentDepth + 1);
    }
  }

  walk(cwd, 1);

  // Filter out repos nested inside another found repo (submodule / monorepo protection).
  return repos.filter(
    (repo) => !repos.some(
      (other) => other !== repo && repo.startsWith(other + sep),
    ),
  );
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
      "git rev-list --left-right --count @{upstream}...HEAD",
      { cwd: repoPath, encoding: "utf8" },
    );
    if (!stdout.trim()) return { ahead: 0, behind: 0 };
    const [behind, ahead] = stdout.trim().split("\t").map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

