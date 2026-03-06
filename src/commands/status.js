import { basename } from "path";
import chalk from "chalk";
import boxen from "boxen";

import { getCurrentBranch, getRepoStatus, getAheadBehind } from "../git/core.js";
import { p } from "../ui/theme.js";
import { colorBranch } from "../ui/colors.js";

export async function cmdStatus(repos) {
  console.log(p.muted(`  Scanning ${repos.length} repositories…\n`));

  const rows = await Promise.all(
    repos.map(async (repo) => {
      const name = basename(repo);
      const [branch, { dirty, count }, { ahead, behind }] = await Promise.all([
        getCurrentBranch(repo),
        getRepoStatus(repo),
        getAheadBehind(repo),
      ]);
      return { name, branch, dirty, count, ahead, behind };
    }),
  );

  rows.sort((a, b) => {
    if (a.dirty && !b.dirty) return -1;
    if (!a.dirty && b.dirty) return 1;
    return a.name.localeCompare(b.name);
  });

  const maxName   = Math.max(...rows.map((r) => r.name.length), 4);
  const maxBranch = Math.max(...rows.map((r) => r.branch.length), 6);

  const divider = p.dim("─".repeat(maxName + maxBranch + 30));

  console.log(
    "  " + p.slate("REPO".padEnd(maxName)) +
    "  " + p.slate("BRANCH".padEnd(maxBranch)) +
    "  " + p.slate("STATUS".padEnd(16)) +
    "  " + p.slate("SYNC"),
  );
  console.log("  " + divider);

  for (const r of rows) {
    const namePad   = r.name.padEnd(maxName);
    const branchPad = r.branch.padEnd(maxBranch);

    const statusIcon = r.dirty ? p.yellow("✎") : p.green("✔");
    const statusText = r.dirty
      ? p.yellow(`${r.count} file${r.count !== 1 ? "s" : ""} changed`).padEnd(24)
      : p.green("clean").padEnd(24);

    const syncParts = [];
    if (r.ahead  > 0) syncParts.push(p.cyan(`↑${r.ahead}`));
    if (r.behind > 0) syncParts.push(p.red(`↓${r.behind}`));
    const syncStr = syncParts.length ? syncParts.join(" ") : p.dim("—");

    console.log(
      "  " + chalk.bold(p.white(namePad)) +
      "  " + colorBranch(branchPad) +
      "  " + statusIcon + " " + statusText +
      "  " + syncStr,
    );
  }

  console.log("  " + divider);
  console.log();

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const totalFiles = rows.reduce((s, r) => s + r.count, 0);
  const cleanCount = rows.length - dirtyCount;

  const sep   = p.slate("   ·   ");
  const parts = [p.white(`${rows.length} repos`), p.green(`${cleanCount} clean`)];
  if (dirtyCount > 0) {
    parts.push(p.yellow(`${dirtyCount} dirty · ${totalFiles} file${totalFiles !== 1 ? "s" : ""}`));
  }

  console.log(
    boxen(parts.join(sep), {
      padding: { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: dirtyCount > 0 ? "#fbbf24" : "#4ade80",
    }),
  );
  console.log();
}
