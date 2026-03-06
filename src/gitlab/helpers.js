import { execSync } from "child_process";

export function getRemoteUrl(repoPath) {
  try {
    return execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

export function branchToTitle(branch) {
  const segment = branch.split("/").pop() ?? branch;
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

export function isGitLabRemote(url) {
  return /gitlab/i.test(url);
}

export function getDefaultBranch(repoPath) {
  try {
    const out = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null", {
      cwd: repoPath,
      encoding: "utf8",
    }).trim();
    return out.replace(/^refs\/remotes\/origin\//, "") || "main";
  } catch {
    return "main";
  }
}

export function extractGroupFromUrl(url) {
  const path = url
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "");
  const parts = path.split("/");
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join("/");
}

export function detectGroupFromRepos(repos) {
  const freq = new Map();
  for (const repo of repos) {
    const remote = getRemoteUrl(repo);
    if (!isGitLabRemote(remote)) continue;
    const group = extractGroupFromUrl(remote);
    if (group) freq.set(group, (freq.get(group) ?? 0) + 1);
  }
  if (freq.size === 0) return null;
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function getProjectPath(url) {
  return url
    .replace(/^git@[^:]+:/, "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "");
}

export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
