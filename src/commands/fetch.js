import { basename } from "path";
import chalk from "chalk";
import boxen from "boxen";
import { Listr } from "listr2";

import { getAheadBehind } from "../git/core.js";
import { execAsync, extractMsg } from "../utils/exec.js";
import { MAX_JOBS } from "../constants.js";
import { p } from "../ui/theme.js";

export async function cmdFetch(repos) {
  const fetchResults = [];
  const padWidth = String(repos.length).length;

  const tasks = new Listr(
    repos.map((repo, idx) => {
      const name = basename(repo);
      const idx_ = p.muted(`[${String(idx + 1).padStart(padWidth)}/${repos.length}]`);
      return {
        title: idx_ + "  " + chalk.bold(p.white(name)) + p.muted("  fetching…"),
        task: async (_, task) => {
          const t0 = Date.now();
          try {
            await execAsync("git fetch --all --prune", { cwd: repo });
            const { ahead, behind } = await getAheadBehind(repo);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            fetchResults.push({ name, ok: true, ahead, behind, elapsed });

            const syncParts = [];
            if (ahead  > 0) syncParts.push(p.cyan(`↑${ahead}`));
            if (behind > 0) syncParts.push(p.red(`↓${behind}`));
            const syncStr = syncParts.length ? "  " + syncParts.join(" ") : "";

            task.title =
              idx_ + "  " + chalk.bold(p.white(name)) +
              "  " + p.green("✔") +
              "  " + p.muted(elapsed + "s") + syncStr;
          } catch (e) {
            const msg = extractMsg(e);
            fetchResults.push({ name, ok: false, msg });
            task.title =
              idx_ + "  " + chalk.bold(p.white(name)) +
              "  " + p.red("✘") +
              "  " + p.muted(msg.slice(0, 55));
            throw new Error(msg);
          }
        },
      };
    }),
    { concurrent: MAX_JOBS, exitOnError: false },
  );

  await tasks.run().catch(() => {});

  const failed = fetchResults.filter((r) => !r.ok).length;
  const avgMs  = fetchResults
    .filter((r) => r.ok && r.elapsed)
    .reduce((s, r) => s + parseFloat(r.elapsed), 0) /
    (fetchResults.filter((r) => r.ok).length || 1);

  console.log();
  console.log(
    boxen(
      (failed === 0
        ? chalk.bold(p.green(`✔  ${repos.length} repos fetched`))
        : p.green(`✔  ${repos.length - failed} fetched`) + p.slate("   ·   ") + p.red(`✘  ${failed} failed`)) +
      "\n" + p.muted(`avg ${avgMs.toFixed(1)}s/repo`),
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: failed > 0 ? "#f87171" : "#4ade80",
      },
    ),
  );
  console.log();
}
