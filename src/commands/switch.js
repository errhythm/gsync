import { basename } from "path";
import chalk from "chalk";
import boxen from "boxen";
import { select } from "@inquirer/prompts";
import { Listr } from "listr2";

import { getCurrentBranch, getRepoStatus } from "../git/core.js";
import { listMatchingBranches } from "../git/branches.js";
import { execAsync, extractMsg } from "../utils/exec.js";
import { MAX_JOBS } from "../constants.js";
import { p, THEME } from "../ui/theme.js";
import { colorBranch } from "../ui/colors.js";

export async function cmdSwitch(repos, {
  targetBranch, pullChanges, fuzzyMode, createBranch, autoStash, doFetch, dryRun,
}) {
  const badges = [];
  if (pullChanges)  badges.push(p.teal("↓ pull"));
  if (fuzzyMode)    badges.push(p.purple("~ fuzzy"));
  if (createBranch) badges.push(p.cyan("+ create"));
  if (autoStash)    badges.push(p.yellow("⊙ stash"));
  if (doFetch)      badges.push(p.cyan("↺ fetch"));
  if (dryRun)       badges.push(p.orange("◎ dry-run"));

  console.log(
    boxen(
      p.muted("branch") + "  " + chalk.bold(p.cyan(targetBranch)) +
      "   " + p.muted("repos") + "  " + chalk.bold(p.white(String(repos.length))) +
      (badges.length ? "   " + p.slate("·") + "   " + badges.join("  ") : ""),
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
      },
    ),
  );
  console.log();

  let resolvedBranches = repos.map(() => targetBranch);

  if (fuzzyMode) {
    console.log(
      p.muted(`  Resolving "${targetBranch}" across ${repos.length} repo${repos.length !== 1 ? "s" : ""}…\n`),
    );

    for (let i = 0; i < repos.length; i++) {
      const name       = basename(repos[i]);
      const candidates = listMatchingBranches(repos[i], targetBranch);

      if (candidates.length === 0) {
        resolvedBranches[i] = null;
      } else if (candidates.length === 1) {
        resolvedBranches[i] = candidates[0];
      } else {
        resolvedBranches[i] = await select({
          message: chalk.bold(p.white(name)) + p.muted(` — pick branch for "${targetBranch}":`),
          choices: candidates.map((c) => ({ value: c, name: p.cyan(c) })),
          theme:   THEME,
        });
      }
    }
    console.log();
  }

  const stats      = { ok: 0, pulled: 0, skip: 0, fail: 0, stashed: 0, alreadyOn: 0 };
  const failedRepos = [];
  const timings    = [];
  const startAll   = Date.now();
  const numWidth   = String(repos.length).length;

  // ── Phase 1: parallel pre-fetch ───────────────────────────────────────────
  // Fire all fetches concurrently so network latency is paid once (max 1 fetch
  // time) rather than once per Listr slot. Silent — no Listr overhead.
  if (!dryRun) {
    console.log("  " + p.muted(`Pre-fetching ${repos.length} repos in parallel…`));
    // Track which repos fetched successfully so phase 2 knows
    const fetchedSet = new Set();
    await Promise.all(
      repos.map(async (repo, i) => {
        const branch = resolvedBranches[i];
        if (!branch) return;
        try {
          await execAsync(`git fetch origin "${branch}"`, { cwd: repo });
          fetchedSet.add(repo);
        } catch {
          // Branch may not exist on remote — phase 2 will handle it gracefully
        }
      }),
    );
    // Overwrite the line once done
    process.stdout.write("\x1b[1A\x1b[2K");

    // ── Phase 2: switch + pull ────────────────────────────────────────────────
    const tasks = new Listr(
      repos.map((repo, i) => {
        const name   = basename(repo);
        const branch = resolvedBranches[i];
        const idx    = p.muted(`[${String(i + 1).padStart(numWidth)}/${repos.length}]`);

        return {
          title: idx + "  " + chalk.bold(p.white(name)) + p.muted("  waiting…"),
          skip:  () => (branch === null ? "no matching branch" : false),
          task:  async (_, task) => {
            const t0      = Date.now();
            const elapsed = () => p.muted("  " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
            const current = await getCurrentBranch(repo);

            task.title =
              idx + "  " + chalk.bold(p.white(name)) + "  " +
              p.muted(current + " → ") + p.cyan(branch) + p.muted("  …");

            if (current === branch && !pullChanges) {
              stats.ok++;
              stats.alreadyOn++;
              timings.push((Date.now() - t0) / 1000);
              task.title =
                idx + "  " + chalk.bold(p.white(name)) +
                "  " + p.teal("◉") + "  " + colorBranch(branch) +
                p.muted("  already on branch") + elapsed();
              return;
            }

            let stashed = false;
            const { dirty } = autoStash ? await getRepoStatus(repo) : { dirty: false };
            if (dirty) {
              try {
                await execAsync("git stash push --include-untracked -m 'gitmux auto-stash'", { cwd: repo });
                stashed = true;
                stats.stashed++;
              } catch {}
            }

            if (doFetch) {
              try { await execAsync("git fetch --all --prune", { cwd: repo }); } catch {}
            }

            if (current !== branch) {
              try {
                if (createBranch) {
                  try {
                    await execAsync(`git switch "${branch}"`, { cwd: repo });
                  } catch {
                    await execAsync(`git switch -c "${branch}"`, { cwd: repo });
                  }
                } else {
                  await execAsync(`git switch "${branch}"`, { cwd: repo });
                }
              } catch (e) {
                const msg = extractMsg(e);
                if (stashed) {
                  try { await execAsync("git stash pop", { cwd: repo }); } catch {}
                }
                if (/did not match|pathspec|not found|invalid reference/i.test(msg)) {
                  stats.skip++;
                  timings.push((Date.now() - t0) / 1000);
                  task.title =
                    idx + "  " + chalk.bold(p.white(name)) +
                    "  " + p.yellow("⊘") + "  " + p.muted("branch not found") + elapsed();
                  return;
                }
                stats.fail++;
                failedRepos.push({ name, msg });
                timings.push((Date.now() - t0) / 1000);
                task.title =
                  idx + "  " + chalk.bold(p.white(name)) +
                  "  " + p.red("✘") + "  " + p.muted(msg.slice(0, 60)) + elapsed();
                throw new Error(msg);
              }
            }

            let pulled = false;
            if (pullChanges) {
              try {
                await execAsync("git pull", { cwd: repo });
                pulled = true;
              } catch (e) {
                failedRepos.push({ name, msg: "pull failed: " + extractMsg(e) });
              }
            }

            if (stashed) {
              try { await execAsync("git stash pop", { cwd: repo }); } catch {}
            }

            stats.ok++;
            if (pulled) stats.pulled++;
            timings.push((Date.now() - t0) / 1000);

            const tags = [];
            if (pulled)  tags.push(p.teal("↓ pulled"));
            if (stashed) tags.push(p.yellow("⊙ stashed"));
            if (dryRun)  tags.push(p.orange("◎ dry"));

            const transitionLabel = current === branch
              ? colorBranch(branch)
              : p.muted(current + " → ") + colorBranch(branch);

            task.title =
              idx + "  " + chalk.bold(p.white(name)) +
              "  " + p.green("✔") + "  " + transitionLabel +
              (tags.length ? "  " + tags.join("  ") : "") +
              elapsed();
          },
        };
      }),
      {
        concurrent:      MAX_JOBS,
        exitOnError:     false,
        rendererOptions: { collapseSkips: false, collapseErrors: false },
      },
    );

    await tasks.run().catch(() => {});
  } else {
    // dry-run: skip fetch phase, just run the Listr switch tasks
    const tasks = new Listr(
      repos.map((repo, i) => {
        const name   = basename(repo);
        const branch = resolvedBranches[i];
        const idx    = p.muted(`[${String(i + 1).padStart(numWidth)}/${repos.length}]`);
        return {
          title: idx + "  " + chalk.bold(p.white(name)) + p.muted("  waiting…"),
          skip:  () => (branch === null ? "no matching branch" : false),
          task:  async (_, task) => {
            const t0      = Date.now();
            const elapsed = () => p.muted("  " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
            const current = await getCurrentBranch(repo);
            stats.ok++;
            timings.push((Date.now() - t0) / 1000);
            task.title =
              idx + "  " + chalk.bold(p.white(name)) +
              "  " + p.orange("◎") + "  " + p.muted(current + " → ") + colorBranch(branch) +
              p.muted("  dry-run") + elapsed();
          },
        };
      }),
      {
        concurrent:      MAX_JOBS,
        exitOnError:     false,
        rendererOptions: { collapseSkips: false, collapseErrors: false },
      },
    );
    await tasks.run().catch(() => {});
  }

  for (const b of resolvedBranches) {
    if (b === null) stats.skip++;
  }

  console.log();

  const totalElapsed = ((Date.now() - startAll) / 1000).toFixed(1);
  const avgTime = timings.length
    ? (timings.reduce((s, t) => s + t, 0) / timings.length).toFixed(1)
    : "0.0";

  const sep          = p.slate("   ·   ");
  const summaryParts = [];
  if (stats.ok > 0)      summaryParts.push(chalk.bold(p.green(`✔  ${stats.ok} switched`)));
  if (stats.pulled > 0)  summaryParts.push(p.teal(`↓  ${stats.pulled} pulled`));
  if (stats.stashed > 0) summaryParts.push(p.yellow(`⊙  ${stats.stashed} stashed`));
  if (stats.skip > 0)    summaryParts.push(p.yellow(`⊘  ${stats.skip} skipped`));
  if (stats.fail > 0)    summaryParts.push(p.red(`✘  ${stats.fail} failed`));
  if (dryRun)            summaryParts.push(p.orange("◎  dry-run · no changes made"));

  console.log(
    boxen(
      summaryParts.join(sep) +
      "\n" + p.muted(`${totalElapsed}s total · avg ${avgTime}s/repo · ${repos.length} repos`),
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor:
          stats.fail > 0 ? "#f87171" :
          stats.ok === 0 ? "#fbbf24" :
                           "#4ade80",
      },
    ),
  );
  console.log();

  if (failedRepos.length > 0) {
    console.log("  " + chalk.bold(p.white("Errors")));
    console.log("  " + p.dim("─".repeat(50)));
    for (const { name, msg } of failedRepos) {
      console.log(
        "  " + p.red("✘") + " " +
        chalk.bold(p.white(name)) + "  " +
        p.muted(msg.slice(0, 90)),
      );
    }
    console.log();
  }

  return stats.fail > 0 ? 1 : 0;
}
