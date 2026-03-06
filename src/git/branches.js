import { execSync } from "child_process";

export function listMatchingBranches(repoPath, partial) {
  try {
    const out = execSync(`git branch -a --list "*${partial}*"`, {
      cwd: repoPath,
      encoding: "utf8",
    });
    return [
      ...new Set(
        out
          .trim()
          .split("\n")
          .map((b) =>
            b
              .trim()
              .replace(/^\*\s*/, "")
              .replace(/^remotes\/[^/]+\//, ""),
          )
          .filter(Boolean)
          .filter((b) => !b.includes("HEAD")),
      ),
    ];
  } catch {
    return [];
  }
}

export function listRecentBranches(repoPath) {
  try {
    const out = execSync(
      'git for-each-ref --sort=-committerdate --format="%(refname:short)\t%(committerdate:unix)" refs/heads refs/remotes/origin',
      { cwd: repoPath, encoding: "utf8" },
    );
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [rawName, rawTs] = line.split("\t");
        const name = rawName.replace(/^origin\//, "");
        return { name, ts: Number(rawTs) || 0 };
      })
      .filter((branch) => branch.name && branch.name !== "HEAD");
  } catch {
    return [];
  }
}

export function getBranchChoices(repos) {
  const branchMap = new Map();

  for (const repo of repos) {
    for (const branch of listRecentBranches(repo.repo)) {
      const existing = branchMap.get(branch.name);
      if (!existing) {
        branchMap.set(branch.name, { ...branch, repos: [repo.name] });
        continue;
      }
      existing.ts = Math.max(existing.ts, branch.ts);
      if (!existing.repos.includes(repo.name)) {
        existing.repos.push(repo.name);
      }
    }
  }

  return [...branchMap.values()].sort((a, b) => b.ts - a.ts);
}
