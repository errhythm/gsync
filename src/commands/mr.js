import { basename } from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import boxen from "boxen";
import enquirer from "enquirer";
import { input, confirm, select, search } from "@inquirer/prompts";
import { Listr } from "listr2";

import { getCurrentBranch } from "../git/core.js";
import { getBranchChoices } from "../git/branches.js";
import { getRemoteUrl, isGitLabRemote, getDefaultBranch } from "../gitlab/helpers.js";
import { execFileAsync, extractMsg } from "../utils/exec.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { p, THEME } from "../ui/theme.js";
import { colorBranch } from "../ui/colors.js";

export async function cmdMr(repos, opts = {}) {
  const config   = loadConfig();
  const mrConfig = config.mr ?? {};

  // Destructure CLI opts (all optional — absence falls through to interactive prompts)
  const {
    target:      cliTarget,
    mrRepos:     cliMrRepos,
    title:       cliTitle,
    description: cliDescription,
    labels:      cliLabels,
    draft:       cliDraft,
    noPush:      cliNoPush,
    yes:         autoConfirm,
  } = opts;

  try {
    execSync("glab version", { encoding: "utf8", stdio: "pipe" });
  } catch {
    console.log(
      boxen(
        chalk.bold(p.red("glab not found")) + "\n\n" +
        p.muted("The GitLab CLI is required for this feature.\n") +
        p.muted("Install: ") + p.cyan("https://gitlab.com/gitlab-org/cli#installation"),
        {
          padding:        { top: 1, bottom: 1, left: 3, right: 3 },
          borderStyle:    "round",
          borderColor:    "#f87171",
          title:          p.red(" missing dependency "),
          titleAlignment: "center",
        },
      ),
    );
    return 1;
  }

  const repoInfo = await Promise.all(repos.map(async (repo) => {
    const name        = basename(repo);
    const branch      = await getCurrentBranch(repo);
    const remote      = getRemoteUrl(repo);
    const isGitlab    = isGitLabRemote(remote);
    const defBranch   = getDefaultBranch(repo);
    const remoteShort = remote.replace(/^https?:\/\//, "").replace(/\.git$/, "").slice(0, 55);
    return { repo, name, branch, remote, remoteShort, isGitlab, defBranch };
  }));

  const repoChoice = (repo) => ({
    value:       repo,
    name:        chalk.bold(p.white(repo.name)),
    description:
      colorBranch(repo.branch) + "  " +
      (repo.isGitlab ? p.muted(repo.remoteShort) : p.dim(repo.remoteShort || "no remote")),
  });

  const printSelectedRepos = (selected) => {
    if (selected.length === 1) {
      console.log(
        "  " + chalk.bold(p.white(selected[0].name)) +
        "  " + colorBranch(selected[0].branch) + "\n",
      );
      return;
    }
    const maxN = Math.max(...selected.map((r) => r.name.length));
    console.log("  " + p.muted(`${selected.length} repos selected:`));
    console.log("  " + p.dim("─".repeat(maxN + 20)));
    for (const r of selected) {
      console.log(
        "  " + p.muted("◉") + " " +
        chalk.bold(p.white(r.name.padEnd(maxN))) +
        "  " + colorBranch(r.branch),
      );
    }
    console.log();
  };

  const promptRepoSearch = (message, excludedNames = new Set()) =>
    search({
      message,
      source: (input) => {
        const term = (input ?? "").toLowerCase().trim();
        return [
          { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to previous step") },
          ...repoInfo
            .filter((r) => !excludedNames.has(r.name))
            .filter((r) => !term || r.name.toLowerCase().includes(term))
            .map(repoChoice),
        ];
      },
      theme: THEME,
    });

  const promptMultiRepoSearch = async () => {
    const choices = repoInfo.map((repo) => ({
      name:    repo.name,
      value:   repo.name,
      repo,
      message: chalk.bold(p.white(repo.name)),
      hint:
        colorBranch(repo.branch) + "  " +
        (repo.isGitlab ? p.muted(repo.remoteShort) : p.dim(repo.remoteShort || "no remote")),
    }));

    const selectedNames = await enquirer.autocomplete({
      name:     "repos",
      message:  "Select repositories:",
      multiple: true,
      initial:  0,
      limit:    12,
      choices,
      symbols:  { indicator: { on: "◉", off: "◯" } },
      footer() {
        return p.muted("space to toggle, type to filter, enter to confirm, esc to go back");
      },
      suggest(input = "", allChoices = []) {
        const term              = input.toLowerCase().trim();
        const selectedChoices   = allChoices.filter((c) => c.enabled);
        const unselectedChoices = allChoices.filter((c) => !c.enabled);
        const filteredUnselected = term
          ? unselectedChoices.filter((c) =>
              c.repo.name.toLowerCase().includes(term) ||
              c.repo.branch.toLowerCase().includes(term) ||
              c.repo.remoteShort.toLowerCase().includes(term),
            )
          : unselectedChoices;
        return [...selectedChoices, ...filteredUnselected];
      },
    }).catch(() => "__back__");

    if (selectedNames === "__back__") return "__back__";

    return selectedNames
      .map((name) => repoInfo.find((r) => r.name === name))
      .filter(Boolean);
  };

  const promptTargetBranch = async (selectedRepos) => {
    const branchChoices  = getBranchChoices(selectedRepos);
    const defaultTarget  = mrConfig.targetBranch || selectedRepos[0].defBranch || "main";

    if (branchChoices.length > 0) {
      return search({
        message: p.white("Target branch:"),
        source:  (input) => {
          const term = (input ?? "").toLowerCase().trim();
          return [
            { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to repository selection") },
            ...branchChoices
              .filter((b) => !term || b.name.toLowerCase().includes(term))
              .map((b) => {
                const repoLabel = selectedRepos.length === 1
                  ? p.muted("latest local/origin ref")
                  : p.muted(`seen in ${b.repos.length}/${selectedRepos.length} repos`);
                return {
                  value:       b.name,
                  name:        colorBranch(b.name),
                  description: b.name === defaultTarget
                    ? p.teal("default target") + "  " + repoLabel
                    : repoLabel,
                };
              }),
          ];
        },
        theme: THEME,
      });
    }

    return input({
      message:  p.white("Target branch") + p.muted(" (merge into):"),
      default:  defaultTarget,
      theme:    THEME,
      validate: (v) => v.trim() !== "" || "Target branch cannot be empty.",
    });
  };

  let selected;
  let targetBranch;

  // ── Non-interactive path — both --target and (optionally) --repo supplied ────
  if (cliTarget) {
    targetBranch = cliTarget;

    if (cliMrRepos) {
      // Filter by requested repo names
      selected = repoInfo.filter((r) => cliMrRepos.includes(r.name));
      if (selected.length === 0) {
        console.log(p.yellow(`  No matching repos for --repo filter(s).\n`));
        return 1;
      }
    } else {
      // Use all repos in scope
      selected = repoInfo;
    }
  } else {
  // ── Interactive path ─────────────────────────────────────────────────────────
  selectionFlow: while (true) {
    const selMode = await select({
      message: p.white("Scope:"),
      choices: [
        { value: "__back__", name: p.yellow("← Go back"),            description: p.muted("return to mode selection") },
        { value: "single",   name: p.cyan("Single repo")   + p.muted("   search and pick one") },
        { value: "multi",    name: p.purple("Multiple repos") + p.muted("   manually build a selection") },
      ],
      default: mrConfig.scope === "multi" ? "multi" : "single",
      theme:   THEME,
    });

    if (selMode === "__back__") return "__back__";

    console.log();

    while (true) {
      if (selMode === "single") {
        const picked = await promptRepoSearch(p.white("Repository:"));
        console.log();
        if (picked === "__back__") continue selectionFlow;
        selected = [picked];
      } else {
        selected = await promptMultiRepoSearch();
        console.log();
        if (selected === "__back__") continue selectionFlow;
      }

      if (!selected || selected.length === 0) {
        console.log(p.muted("  Nothing selected. Exiting.\n"));
        return 0;
      }

      printSelectedRepos(selected);

      const target = await promptTargetBranch(selected);
      console.log();
      if (target === "__back__") continue;

      targetBranch = target;
      break selectionFlow;
    }
  }
  } // end non-interactive / interactive split

  const title = cliTitle !== null && cliTitle !== undefined
    ? cliTitle
    : await input({
        message: p.white("Title") + p.muted(" (blank → use last commit message):"),
        theme:   THEME,
      });

  const description = cliDescription !== null && cliDescription !== undefined
    ? cliDescription
    : await input({
        message: p.white("Description") + p.muted(" (blank → use commit body):"),
        theme:   THEME,
      });

  const labels = cliLabels !== null && cliLabels !== undefined
    ? cliLabels
    : await input({
        message: p.white("Labels") + p.muted(" (comma separated, optional):"),
        default: mrConfig.labels ?? "",
        theme:   { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
      });

  const isDraft = cliDraft
    ? true
    : await confirm({
        message: p.white("Mark as") + p.muted(" Draft?"),
        default: mrConfig.isDraft ?? false,
        theme:   THEME,
      });

  // --no-push takes priority; cliNoPush=true means skip push
  const pushFirst = cliNoPush
    ? false
    : await confirm({
        message: p.white("Push branch") + p.muted(" to remote before creating MR?"),
        default: mrConfig.pushFirst ?? true,
        theme:   THEME,
      });

  console.log();

  const repoLabel = selected.length === 1
    ? chalk.bold(p.white(selected[0].name))
    : p.white(`${selected.length} repos`) + "  " +
      p.muted(
        selected.map((r) => r.name).join(", ").slice(0, 60) +
        (selected.map((r) => r.name).join(", ").length > 60 ? "…" : ""),
      );

  const sourceLabel = selected.length === 1
    ? colorBranch(selected[0].branch) + p.muted(" → ") + colorBranch(targetBranch)
    : p.muted("each branch") + p.muted(" → ") + colorBranch(targetBranch);

  const previewLines = [
    p.muted("  repo         ") + repoLabel,
    p.muted("  source       ") + sourceLabel,
    p.muted("  title        ") + (title.trim() ? chalk.bold(p.white(title)) : p.dim("← last commit message")),
    p.muted("  description  ") + (description.trim()
      ? p.white(description.slice(0, 60) + (description.length > 60 ? "…" : ""))
      : p.dim(title.trim() ? "—" : "← commit body")),
    labels    ? p.muted("  labels       ") + p.purple(labels)  : null,
    isDraft   ? p.muted("  flags        ") + p.yellow("draft") : null,
    pushFirst ? p.muted("  push first   ") + p.teal("yes")     : null,
  ].filter(Boolean).join("\n");

  console.log(
    boxen(previewLines, {
      padding:        { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle:    "round",
      borderColor:    "#334155",
      title:          p.muted(" merge request preview "),
      titleAlignment: "right",
    }),
  );
  console.log();

  const confirmed = autoConfirm
    ? true
    : await confirm({
        message: p.white(
          selected.length === 1 ? "Create merge request?" : `Create ${selected.length} merge requests?`,
        ),
        default: true,
        theme:   THEME,
      });

  if (!confirmed) {
    console.log("\n" + p.muted("  Aborted.\n"));
    return 0;
  }

  saveConfig({
    ...config,
    mr: {
      ...mrConfig,
      scope:        selected.length > 1 ? "multi" : "single",
      targetBranch,
      labels,
      isDraft,
      pushFirst,
    },
  });

  console.log();

  const buildGlabArgs = () => {
    const a = ["mr", "create", "--target-branch", targetBranch, "--yes"];
    if (title.trim()) {
      a.push("--title", title.trim());
    } else {
      a.push("--fill");
    }
    if (description.trim()) a.push("--description", description.trim());
    if (isDraft)             a.push("--draft");
    if (labels)              a.push("--label", labels);
    if (pushFirst)           a.push("--push");
    return a;
  };

  const mrResults = [];
  const numWidth  = String(selected.length).length;

  const tasks = new Listr(
    selected.map((r, i) => {
      const idx = p.muted(`[${String(i + 1).padStart(numWidth)}/${selected.length}]`);
      return {
        title:
          idx + "  " + chalk.bold(p.white(r.name)) + "  " +
          colorBranch(r.branch) + p.muted(" → ") + colorBranch(targetBranch) +
          p.muted("  opening…"),
        task: async (_, task) => {
          const t0 = Date.now();
          try {
            const { stdout, stderr } = await execFileAsync("glab", buildGlabArgs(), { cwd: r.repo });
            const combined = (stdout + "\n" + stderr).trim();
            const url      = combined.split("\n").find((l) => /https?:\/\//.test(l))?.trim() ?? "";
            const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);

            mrResults.push({ name: r.name, ok: true, url });
            task.title =
              idx + "  " + chalk.bold(p.white(r.name)) +
              "  " + p.green("✔") + "  " +
              colorBranch(r.branch) + p.muted(" → ") + colorBranch(targetBranch) +
              (url ? "  " + p.cyan(url) : "") +
              p.muted("  " + elapsed + "s");
          } catch (e) {
            const raw = (e.stdout ?? "") + (e.stderr ?? "");
            const url = raw.split("\n").find((l) => /https?:\/\//.test(l))?.trim() ?? "";
            const msg = extractMsg(e);

            if (url) {
              mrResults.push({ name: r.name, ok: true, url, existing: true });
              task.title =
                idx + "  " + chalk.bold(p.white(r.name)) +
                "  " + p.teal("◉") +
                "  " + p.muted("MR already exists  ") + p.cyan(url);
            } else {
              mrResults.push({ name: r.name, ok: false, msg });
              task.title =
                idx + "  " + chalk.bold(p.white(r.name)) +
                "  " + p.red("✘") +
                "  " + p.muted(msg.slice(0, 70));
              throw new Error(msg);
            }
          }
        },
      };
    }),
    { concurrent: false, exitOnError: false },
  );

  await tasks.run().catch(() => {});

  console.log();

  const opened   = mrResults.filter((r) => r.ok && !r.existing);
  const existing = mrResults.filter((r) => r.ok &&  r.existing);
  const failed   = mrResults.filter((r) => !r.ok);
  const sep      = p.slate("   ·   ");

  const summaryParts = [];
  if (opened.length)   summaryParts.push(chalk.bold(p.green(`✔  ${opened.length} opened`)));
  if (existing.length) summaryParts.push(p.teal(`◉  ${existing.length} already existed`));
  if (failed.length)   summaryParts.push(p.red(`✘  ${failed.length} failed`));

  console.log(
    boxen(
      summaryParts.join(sep) +
      "\n" + p.muted(`${selected.length} repo${selected.length !== 1 ? "s" : ""} processed`),
      {
        padding:     { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: failed.length > 0 ? "#f87171" : "#4ade80",
      },
    ),
  );

  const successful = mrResults.filter((r) => r.ok && r.url);
  if (successful.length > 0) {
    const maxN = Math.max(...successful.map((r) => r.name.length));
    console.log();
    console.log("  " + chalk.bold(p.white("Merge Requests")));
    console.log("  " + p.dim("─".repeat(50)));
    for (const r of successful) {
      const badge = r.existing ? p.teal("◉") : p.green("✔");
      console.log(
        "  " + badge + "  " +
        chalk.bold(p.white(r.name.padEnd(maxN))) +
        "  " + p.cyan(r.url),
      );
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log("  " + chalk.bold(p.white("Errors")));
    console.log("  " + p.dim("─".repeat(50)));
    for (const r of failed) {
      console.log(
        "  " + p.red("✘") + " " +
        chalk.bold(p.white(r.name)) +
        "  " + p.muted(r.msg.slice(0, 90)),
      );
    }
  }

  console.log();
  return failed.length > 0 ? 1 : 0;
}
