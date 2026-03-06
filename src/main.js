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

function parseArgs(rawArgs) {
  const flags = new Set();
  const options = {};
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if ((arg === "--depth" || arg === "--exclude" || arg === "--filter") && rawArgs[i + 1]) {
      options[arg.slice(2)] = rawArgs[++i];
    } else if (arg.startsWith("--depth=")) {
      options.depth = arg.slice(8);
    } else if (arg.startsWith("--exclude=")) {
      options.exclude = arg.slice(10);
    } else if (arg.startsWith("--filter=")) {
      options.filter = arg.slice(9);
    } else if (!arg.startsWith("--") && arg.startsWith("-") && arg.length > 2) {
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
    subcommand: isSubcmd ? first : null,
    branch: isSubcmd ? (positional[1] ?? "") : first,
    pull: flags.has("--pull") || flags.has("-p"),
    fuzzy: flags.has("--fuzzy") || flags.has("-f"),
    create: flags.has("--create") || flags.has("-c"),
    stash: flags.has("--stash") || flags.has("-s"),
    fetch: flags.has("--fetch"),
    dryRun: flags.has("--dry-run"),
    version: flags.has("--version") || flags.has("-v"),
    help: flags.has("--help") || flags.has("-h"),
    settings: flags.has("--settings"),
    depth: parseInt(options.depth ?? String(DEFAULT_DEPTH), 10) || DEFAULT_DEPTH,
    exclude: options.exclude ?? null,
    filter: options.filter ?? null,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function main() {
  process.on("SIGINT", () => { console.log("\n\n" + p.muted("  Interrupted.") + "\n"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\n\n" + p.muted("  Terminated.") + "\n"); process.exit(0); });

  const opts = parseArgs(process.argv.slice(2));
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
    return await cmdMr(repos);
  }

  if (opts.subcommand === "portal") {
    return await cmdPortal(repos, { settings: opts.settings });
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
    while (true) {
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

      if (mode === "switch") break;

      if (mode === "portal") {
        const result = await cmdPortal(repos);
        if (result !== "__back__") return result;
        continue;
      }
    }

    const branchSuggestions = getSwitchBranchSuggestions(config);

    if (branchSuggestions.length > 0) {
      const branchChoice = await select({
        message: p.white("Suggested branch:"),
        choices: [
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
