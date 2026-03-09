import { basename } from "path";
import chalk from "chalk";
import boxen from "boxen";
import { input, confirm, select } from "@inquirer/prompts";

import { VERSION, DEFAULT_DEPTH, SUBCOMMANDS } from "./constants.js";
import { findRepos } from "./git/core.js";
import { getSwitchBranchSuggestions } from "./git/templates.js";
import { loadConfig, saveConfig } from "./config/index.js";
import { printLogo, printHelp, printAbout } from "./ui/print.js";
import { p, THEME } from "./ui/theme.js";
import { colorBranch } from "./ui/colors.js";
import { cmdStatus } from "./commands/status.js";
import { cmdFetch } from "./commands/fetch.js";
import { cmdSwitch } from "./commands/switch.js";
import { cmdMr } from "./commands/mr.js";
import { cmdPortal } from "./commands/portal.js";
import { cmdSettings } from "./commands/settings.js";

// ── Argument parser ───────────────────────────────────────────────────────────

// Options that take a value argument
const VALUE_OPTIONS = new Set([
  "--depth", "--exclude", "--filter",
  // mr
  "--target", "-t", "--repo", "--title", "--description", "--labels",
  // portal
  "--epic", "--issue-project", "--issue-title", "--issue-description",
  "--issue-labels", "--branch-name", "--base-branch",
]);

function parseArgs(rawArgs) {
  const flags = new Set();
  const options = {};
  const positional = [];
  // Multi-value: --repo can appear multiple times
  const repos = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (VALUE_OPTIONS.has(arg) && rawArgs[i + 1] !== undefined) {
      const key = arg.replace(/^-+/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (arg === "--repo") {
        repos.push(rawArgs[++i]);
      } else {
        options[key] = rawArgs[++i];
      }
    } else if (arg.includes("=") && arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const key = arg.slice(2, eqIdx).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[key] = arg.slice(eqIdx + 1);
    } else if (!arg.startsWith("--") && arg.startsWith("-") && arg.length > 2 && arg !== "-t") {
      for (const c of arg.slice(1)) flags.add(`-${c}`);
    } else if (arg.startsWith("-")) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }

  const first = positional[0] ?? "";
  const isSubcmd = SUBCOMMANDS.has(first);

  return {
    // ── Core ────────────────────────────────────────────────────────────────
    subcommand: isSubcmd ? first : null,
    branch: isSubcmd ? (positional[1] ?? "") : first,

    // ── Switch flags ────────────────────────────────────────────────────────
    pull:     flags.has("--pull")    || flags.has("-p"),
    fuzzy:    flags.has("--fuzzy")   || flags.has("-f"),
    create:   flags.has("--create")  || flags.has("-c"),
    stash:    flags.has("--stash")   || flags.has("-s"),
    fetch:    flags.has("--fetch"),
    dryRun:   flags.has("--dry-run"),

    // ── Global ──────────────────────────────────────────────────────────────
    version:  flags.has("--version") || flags.has("-v"),
    help:     flags.has("--help")    || flags.has("-h"),
    settings: flags.has("--settings"),
    debug:    flags.has("--debug"),
    yes:      flags.has("--yes")     || flags.has("-y"),
    depth:    parseInt(options.depth ?? String(DEFAULT_DEPTH), 10) || DEFAULT_DEPTH,
    exclude:  options.exclude ?? null,
    filter:   options.filter ?? null,

    // ── MR flags ─────────────────────────────────────────────────────────────
    // --target / -t <branch>  — MR target branch
    target:      options.target ?? options.t ?? null,
    // --repo <name>  (repeatable) — restrict MR to these repos
    mrRepos:     repos.length > 0 ? repos : null,
    // --title / --description / --labels — MR or issue metadata
    title:       options.title       ?? null,
    description: options.description ?? null,
    labels:      options.labels      ?? null,
    // --draft  — mark MR as draft
    draft:       flags.has("--draft"),
    // --no-push  — skip git push before MR
    noPush:      flags.has("--no-push"),

    // ── Portal flags ──────────────────────────────────────────────────────────
    // --epic <iid>  — select epic by IID non-interactively
    epic:             options.epic             ?? null,
    // --checkout  — run epic checkout without menus
    checkout:         flags.has("--checkout"),
    // --create-mr  — create bulk MRs for epic without menus
    createMr:         flags.has("--create-mr"),
    // --create-issue  — go straight to issue creation
    createIssue:      flags.has("--create-issue"),
    // Issue creation params
    issueProject:     options.issueProject     ?? null,
    issueTitle:       options.issueTitle       ?? null,
    issueDescription: options.issueDescription ?? null,
    issueLabels:      options.issueLabels      ?? null,
    branchName:       options.branchName       ?? null,
    baseBranch:       options.baseBranch       ?? null,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function main() {
  process.on("SIGINT", () => { console.log("\n\n" + p.muted("  Interrupted.") + "\n"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\n\n" + p.muted("  Terminated.") + "\n"); process.exit(0); });

  const opts = parseArgs(process.argv.slice(2));
  if (opts.debug) process.env.GSYNC_DEBUG = "1";  // set before any module uses it
  const config = loadConfig();

  if (opts.version) {
    console.log(`gsync v${VERSION}`);
    return 0;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.subcommand === "about") {
    printAbout();
    return 0;
  }

  process.stdout.write("\x1Bc");
  printLogo();

  const cwd = process.cwd();
  let repos = findRepos(cwd, opts.depth);

  if (repos.length === 0) {
    console.log(
      boxen(p.red("No git repositories found in the current directory."), {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: "red",
      }),
    );
    return 1;
  }

  if (opts.filter) {
    const pat = opts.filter.toLowerCase();
    const before = repos.length;
    repos = repos.filter((r) => basename(r).toLowerCase().includes(pat));
    if (repos.length === 0) {
      console.log(p.yellow(`  No repos matched --filter "${opts.filter}". Nothing to do.\n`));
      return 0;
    }
    console.log(
      p.muted(`  ${repos.length} repos matched --filter "${opts.filter}" (${before - repos.length} hidden)\n`),
    );
  }

  if (opts.exclude) {
    const pat = opts.exclude.toLowerCase();
    const before = repos.length;
    repos = repos.filter((r) => !basename(r).toLowerCase().includes(pat));
    if (repos.length === 0) {
      console.log(
        p.yellow(`  All ${before} repos matched --exclude "${opts.exclude}". Nothing to do.\n`),
      );
      return 0;
    }
    console.log(
      p.muted(`  ${repos.length} repos · ${before - repos.length} excluded via "${opts.exclude}"\n`),
    );
  }

  // ── Subcommands ───────────────────────────────────────────────────────────

  if (opts.subcommand === "status") {
    await cmdStatus(repos);
    return 0;
  }

  if (opts.subcommand === "fetch") {
    console.log();
    await cmdFetch(repos);
    return 0;
  }

  if (opts.subcommand === "mr") {
    return await cmdMr(repos, {
      target:      opts.target,
      mrRepos:     opts.mrRepos,
      title:       opts.title,
      description: opts.description,
      labels:      opts.labels,
      draft:       opts.draft,
      noPush:      opts.noPush,
      yes:         opts.yes,
    });
  }

  if (opts.subcommand === "portal") {
    return await cmdPortal(repos, {
      settings:         opts.settings,
      epic:             opts.epic,
      checkout:         opts.checkout,
      createMr:         opts.createMr,
      createIssue:      opts.createIssue,
      target:           opts.target,
      title:            opts.title,
      description:      opts.description,
      labels:           opts.labels,
      draft:            opts.draft,
      noPush:           opts.noPush,
      issueProject:     opts.issueProject,
      issueTitle:       opts.issueTitle,
      issueDescription: opts.issueDescription,
      issueLabels:      opts.issueLabels,
      branchName:       opts.branchName,
      baseBranch:       opts.baseBranch,
      yes:              opts.yes,
    });
  }

  if (opts.subcommand === "settings") {
    return await cmdSettings(repos);
  }

  // ── Interactive switch mode ────────────────────────────────────────────────

  let {
    branch: targetBranch,
    pull: pullChanges,
    fuzzy: fuzzyMode,
    create: createBranch,
    stash: autoStash,
    fetch: doFetch,
    dryRun,
  } = opts;

  if (!targetBranch) {
    console.log(
      "  " + p.muted("Found ") + p.white(String(repos.length)) +
      p.muted(` ${repos.length === 1 ? "repo" : "repos"} in scope\n`),
    );

    // Mode selector — loop so "go back" from sub-commands returns here
    modeLoop: while (true) {
      const mode = await select({
        message: p.white("What do you want to do?"),
        choices: [
          {
            value: "switch",
            name: p.cyan("⇌  Switch branches") + p.muted("   checkout a branch across all repos"),
          },
          {
            value: "portal",
            name: chalk.hex("#FC6D26")("◈  GitLab") + p.muted("   development portal — epics, MRs & branches"),
          },
        ],
        theme: THEME,
      });

      console.log();

      if (mode === "portal") {
        const result = await cmdPortal(repos);
        if (result !== "__back__") return result;
        continue;
      }

      // ── Switch branch flow (with back support) ─────────────────────────────
      const branchSuggestions = getSwitchBranchSuggestions(config);

      if (branchSuggestions.length > 0) {
        const branchChoice = await select({
          message: p.white("Suggested branch:"),
          choices: [
            { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to main menu") },
            ...branchSuggestions.map((item) => ({
              value: item.value,
              name: colorBranch(item.value),
              description: p.muted(item.template),
            })),
            {
              value: "__custom__",
              name: p.white("Custom branch..."),
              description: p.muted("type any branch name or partial"),
            },
          ],
          theme: THEME,
        });

        console.log();

        if (branchChoice === "__back__") continue modeLoop;

        if (branchChoice === "__custom__") {
          targetBranch = await input({
            message: p.white("Branch name") + p.muted(" (or partial):"),
            theme: THEME,
            validate: (v) => v.trim() !== "" || "Branch name cannot be empty",
          });
        } else {
          targetBranch = branchChoice;
        }
      } else {
        targetBranch = await input({
          message: p.white("Branch name") + p.muted(" (or partial):"),
          theme: THEME,
          validate: (v) => v.trim() !== "" || "Branch name cannot be empty",
        });
      }

      break modeLoop; // branch was chosen — proceed to confirm prompts
    }

    const switchDefaults = config.switch?.lastOptions ?? {};

    pullChanges = await confirm({
      message: p.white("Pull") + p.muted(" after switching?"),
      default: switchDefaults.pull ?? false,
      theme: THEME,
    });

    fuzzyMode = await confirm({
      message: p.white("Fuzzy") + p.muted(" / partial branch matching?"),
      default: switchDefaults.fuzzy ?? false,
      theme: THEME,
    });

    autoStash = await confirm({
      message: p.white("Auto-stash") + p.muted(" dirty repos before switching?"),
      default: switchDefaults.stash ?? false,
      theme: THEME,
    });

    saveConfig({
      ...config,
      switch: {
        ...config.switch,
        lastOptions: { pull: pullChanges, fuzzy: fuzzyMode, stash: autoStash },
      },
    });

    console.log();
  }


  return await cmdSwitch(repos, {
    targetBranch,
    pullChanges,
    fuzzyMode,
    createBranch,
    autoStash,
    doFetch,
    dryRun,
  });
}
