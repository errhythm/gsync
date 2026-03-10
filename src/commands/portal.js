import { basename } from "path";
import { execSync } from "child_process";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import { Listr } from "listr2";

const execFileAsync = promisify(execFile);
import boxen from "boxen";
import enquirer from "enquirer";
import { input, confirm, select, search } from "@inquirer/prompts";

import { getCurrentBranch } from "../git/core.js";
import { glabApi, glabGraphQL } from "../gitlab/api.js";
import {
  getRemoteUrl,
  isGitLabRemote,
  detectGroupFromRepos,
  getProjectPath,
  slugify,
} from "../gitlab/helpers.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { p, THEME } from "../ui/theme.js";
import { colorBranch, colorLabel } from "../ui/colors.js";
export { cmdPortalSettings } from "./settings.js";
import { cmdMr } from "./mr.js";

// ── GraphQL epic query ────────────────────────────────────────────────────────
// Fetches epics assigned to the given username (and optionally filtered by label)
// via the GitLab Work Items GraphQL API.
// Returns an array of { iid, title, due_date, web_url } objects.
async function fetchAssignedEpics(groupPath, username, epicLabelFilter = null) {
  const labelArg = epicLabelFilter ? `, labelName: "${epicLabelFilter}"` : "";
  const query = `{
    group(fullPath: "${groupPath}") {
      workItems(first: 100, types: [EPIC], assigneeUsernames: ["${username}"]${labelArg}, state: opened) {
        nodes {
          id iid title webUrl
          widgets {
            type
            ... on WorkItemWidgetLabels {
              labels { nodes { title } }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }`;

  const data = await glabGraphQL(query);
  const nodes = data?.group?.workItems?.nodes ?? [];

  return nodes.map((e) => ({
    iid: e.iid,
    id: e.id,    // gid://gitlab/Epic/12345 — needed for issue creation via REST
    title: e.title,
    web_url: e.webUrl,
    labels: e.widgets?.find((w) => w.type === "LABELS")?.labels?.nodes?.map((l) => l.title) ?? [],
  }));
}

// ── Group resolver ─────────────────────────────────────────────────────────────
// Probes group path candidates from top-level down (e.g. "a/b/c" → ["a","a/b","a/b/c"])
// and returns the highest-level group that has epics for the user.
// Falls back to the top-level group if no assigned epics are found at any level.
async function resolveEpicGroup(rawGroupPath, username, epicLabelFilter = null) {
  const parts = rawGroupPath.split("/").filter(Boolean);
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));

  for (const candidate of candidates) {
    try {
      const epics = await fetchAssignedEpics(candidate, username, epicLabelFilter);
      if (epics.length > 0) return candidate;
    } catch {
      // Group might not exist at this level — try next
    }
  }

  return parts[0];
}

// ── Epic issues ────────────────────────────────────────────────────────────────

async function fetchEpicIssues(group, epicIid) {
  try {
    const enc = encodeURIComponent(group);
    const issues = await glabApi(`groups/${enc}/epics/${epicIid}/issues?per_page=50`);
    return Array.isArray(issues) ? issues : [];
  } catch {
    return [];
  }
}

function printEpicIssues(issues, primaryBranches = {}) {
  if (issues.length === 0) {
    console.log("  " + p.muted("No issues yet in this epic.\n"));
    return;
  }

  const openCount = issues.filter((i) => i.state === "opened").length;
  const closedCount = issues.length - openCount;

  const rows = issues.map((issue) => {
    const ref = issue.references?.full ?? "";
    const refParts = ref.split("#");
    const projectName = (refParts[0] ?? "").split("/").pop() ?? "";
    const localIid = refParts[1] ?? String(issue.iid);
    const statusDot = issue.state === "opened" ? p.green("●") : p.muted("○");
    const keyLabel = issue.labels?.find((l) => l.startsWith("STA::")) ?? "";
    const primary = primaryBranches[ref] ?? null;
    return { statusDot, localIid, projectName, title: issue.title, keyLabel, primary };
  });

  const maxProject = Math.max(...rows.map((r) => r.projectName.length), 7);
  const divider = "  " + p.muted("─".repeat(maxProject + 75));

  console.log(divider);
  for (const r of rows) {
    const iidPad = `#${r.localIid}`.padEnd(5);
    const titleSlice = r.title.length > 55 ? r.title.slice(0, 54) + "…" : r.title.padEnd(55);
    console.log(
      "  " + r.statusDot +
      " " + p.muted(iidPad) +
      "  " + p.white(r.projectName.padEnd(maxProject)) +
      "  " + p.muted(titleSlice) +
      (r.keyLabel ? "  " + colorLabel(r.keyLabel) : "") +
      (r.primary ? "  " + p.teal("⎇") + " " + colorBranch(r.primary) : ""),
    );
  }
  console.log(divider);
  console.log(
    "  " +
    p.muted(`${issues.length} issue${issues.length !== 1 ? "s" : ""}`) +
    (openCount > 0 ? "  " + p.green(`${openCount} open`) : "") +
    (closedCount > 0 ? "  " + p.muted(`${closedCount} closed`) : "") +
    "\n",
  );
}

// ── Browser helper ─────────────────────────────────────────────────────────────

function openUrl(url) {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  try { execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch { }
}

// ── CodeRabbit CLI detection ───────────────────────────────────────────────────
// Returns true if the `cr` (or `coderabbit`) CLI is available on $PATH.
function isCrAvailable() {
  try {
    execSync("cr --version", { stdio: "pipe" });
    return true;
  } catch {
    try {
      execSync("coderabbit --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Issue branches ─────────────────────────────────────────────────────────────

// Config key that uniquely identifies an issue across projects
function issueConfigKey(issue) {
  const ref = issue.references?.full ?? "";
  return ref || `unknown#${issue.iid}`;
}

// Fetch branches for a project that reference a given issue IID in their name.
// Uses GitLab's ?search= to pre-filter and paginates in case there are many results.
async function fetchIssueBranches(projectPath, issueIid) {
  try {
    const enc = encodeURIComponent(projectPath);
    const pattern = new RegExp(`(^|[/._-])${issueIid}([^0-9]|$)`);
    const results = [];
    let page = 1;

    while (true) {
      const branches = await glabApi(
        `projects/${enc}/repository/branches?search=${issueIid}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(branches) || branches.length === 0) break;
      results.push(...branches.filter((b) => pattern.test(b.name)));
      if (branches.length < 100) break;
      page++;
    }

    return results;
  } catch {
    return [];
  }
}

// Interactive issue detail view — shows branches and lets the user set a primary branch
async function cmdIssueView(issue, glabRepos = [], portalConfig = {}) {
  const ref = issue.references?.full ?? "";
  const [projectPath, localIid] = ref.split("#");
  const projectName = (projectPath ?? "").split("/").pop() ?? "";
  const configKey = issueConfigKey(issue);

  // Issue info
  const labelLine = issue.labels?.length > 0
    ? "\n" + p.muted("  labels   ") + issue.labels.map((l) => colorLabel(l)).join(p.muted("  "))
    : "";
  console.log(
    boxen(
      p.muted("  project  ") + p.white(projectName) + "\n" +
      p.muted("  title    ") + chalk.bold(p.white(issue.title)) + "\n" +
      p.muted("  state    ") + (issue.state === "opened" ? p.green("open") : p.muted("closed")) +
      labelLine + "\n" +
      p.muted("  url      ") + p.muted(issue.web_url ?? ""),
      {
        padding: { top: 0, bottom: 0, left: 1, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
        title: p.muted(` issue #${localIid} `),
        titleAlignment: "left",
      },
    ),
  );
  console.log();

  // Fetch branches
  process.stdout.write("  " + p.muted("Loading branches…\r"));
  const branches = await fetchIssueBranches(projectPath, localIid);
  process.stdout.write(" ".repeat(40) + "\r");

  const cfg = loadConfig();
  const primaryBranches = cfg.portal?.primaryBranches ?? {};
  const currentPrimary = primaryBranches[configKey] ?? null;

  // Show branch list
  if (branches.length > 0) {
    for (const b of branches) {
      const isPrimary = b.name === currentPrimary;
      const date = (b.commit?.committed_date ?? "").slice(0, 10);
      console.log(
        "  " + (isPrimary ? p.teal("★") : p.muted("·")) +
        "  " + colorBranch(b.name) +
        (isPrimary ? "  " + p.teal("primary") : "") +
        (date ? "  " + p.muted(date) : ""),
      );
    }
    console.log();
  } else {
    console.log("  " + p.muted("No branches found for this issue.\n"));
  }

  // Action menu
  const issueAction = await select({
    message: p.white("Action:"),
    choices: [
      ...(branches.length > 0 ? [{
        value: "primary",
        name: p.cyan("⎇  Set primary branch"),
        description: currentPrimary ? p.muted("current: ") + colorBranch(currentPrimary) : p.muted("none set"),
      }] : []),
      ...(currentPrimary ? [{
        value: "mr",
        name: p.purple("⊞  Create merge request"),
        description: p.muted("MR from ") + colorBranch(currentPrimary) + p.muted(" → default base branch"),
      }] : []),
      {
        value: "open",
        name: p.teal("⊕  View in GitLab"),
        description: p.muted(issue.web_url ?? ""),
      },
      { value: "back", name: p.yellow("← Back") },
    ],
    theme: THEME,
  });
  console.log();

  if (issueAction === "open") {
    openUrl(issue.web_url);
    return;
  }
  if (issueAction === "back") return;

  // Create MR from primary branch
  if (issueAction === "mr") {
    await cmdIssueMr(issue, glabRepos, portalConfig);
    return;
  }

  // Set primary branch
  const primaryChoice = await search({
    message: p.white("Set primary branch:"),
    source: (val) => {
      const term = (val ?? "").toLowerCase().trim();
      return [
        { value: "__cancel__", name: p.yellow("← Cancel"), description: p.muted("return to action menu without changing") },
        { value: null, name: p.muted("— none —"), description: p.muted("clear primary branch") },
        ...branches
          .filter((b) => !term || b.name.toLowerCase().includes(term))
          .map((b) => ({
            value: b.name,
            name: colorBranch(b.name),
            description: b.name === currentPrimary ? p.teal("★ current primary") : "",
          })),
      ];
    },
    theme: THEME,
  });
  console.log();

  if (primaryChoice === "__cancel__") return;

  // Persist
  const fresh = loadConfig();
  const updated = { ...(fresh.portal?.primaryBranches ?? {}), [configKey]: primaryChoice };
  if (primaryChoice === null) delete updated[configKey];
  saveConfig({ ...fresh, portal: { ...fresh.portal, primaryBranches: updated } });

  if (primaryChoice) {
    console.log("  " + p.green("✔") + "  " + p.muted("Primary →") + "  " + colorBranch(primaryChoice) + "\n");
  } else {
    console.log("  " + p.muted("Primary branch cleared.\n"));
  }
}

// ── Issue MR creation ────────────────────────────────────────────────────────
// Creates an MR via the GitLab REST API directly (avoids glab mr create CLI
// argument parsing issues with special characters in titles).
async function createMrViaApi(projectPath, { sourceBranch, targetBranch, title, description, labels, isDraft }) {
  const enc = encodeURIComponent(projectPath);
  const fields = {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    title: title.trim(),
  };
  if (description?.trim()) fields.description = description.trim();
  if (labels?.trim()) fields.labels = labels.trim();
  if (isDraft) fields.draft = true;
  return glabApi(`projects/${enc}/merge_requests`, { method: "POST", fields });
}

// Single-issue MR — called from cmdIssueView.
async function cmdIssueMr(issue, glabRepos, portalConfig) {
  const ref = issue.references?.full ?? "";
  const [projectPath, localIid] = ref.split("#");
  const configKey = issueConfigKey(issue);
  const primary = (loadConfig().portal?.primaryBranches ?? {})[configKey] ?? null;

  if (!primary) {
    console.log("  " + p.yellow("No primary branch set.") + p.muted("  Use \"Set primary branch\" first.\n"));
    return;
  }
  const localRepo = findLocalRepo(glabRepos, projectPath);
  if (!localRepo) {
    console.log("  " + p.yellow("No local repo found for this issue.") + p.muted("  Is it within the current search scope?\n"));
    return;
  }

  const targetBranch = await input({
    message: p.white("Target branch") + p.muted(" (merge into):"),
    default: portalConfig.defaultBaseBranch ?? "develop",
    theme: THEME,
    validate: (v) => v.trim() !== "" || "Required",
  });
  const title = await input({
    message: p.white("Title:"),
    default: issue.title,
    theme: THEME,
    validate: (v) => v.trim() !== "" || "Required",
  });
  const description = await input({ message: p.white("Description:"), default: "", theme: THEME });
  const labels = await input({
    message: p.white("Labels") + p.muted(" (optional):"),
    default: portalConfig.defaultLabels ?? "",
    theme: { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
  });
  const isDraft = await confirm({ message: p.white("Mark as") + p.muted(" Draft?"), default: false, theme: THEME });
  const pushFirst = await confirm({ message: p.white("Push branch") + p.muted(" first?"), default: true, theme: THEME });
  console.log();

  console.log(
    boxen(
      p.muted("  source   ") + colorBranch(primary) + p.muted(" → ") + colorBranch(targetBranch) + "\n" +
      p.muted("  title    ") + chalk.bold(p.white(title)) + "\n" +
      p.muted("  project  ") + p.white(localRepo.name) +
      (labels?.trim() ? "\n" + p.muted("  labels   ") + p.purple(labels) : "") +
      (isDraft ? "\n" + p.muted("  flags    ") + p.yellow("draft") : ""),
      {
        padding: { top: 1, bottom: 1, left: 2, right: 2 }, borderStyle: "round", borderColor: "#334155",
        title: p.muted(" merge request preview "), titleAlignment: "right"
      },
    ),
  );
  console.log();

  const ok = await confirm({ message: p.white("Create merge request?"), default: true, theme: THEME });
  console.log();
  if (!ok) return;

  process.stdout.write("  " + p.muted("Creating MR…\r"));
  try {
    if (pushFirst) {
      process.stdout.write("  " + p.muted(`Pushing ${primary}…\r`));
      await execFileAsync("git", ["push", "-u", "origin", primary], { cwd: localRepo.repo }).catch(() => { });
    }
    const mr = await createMrViaApi(projectPath, { sourceBranch: primary, targetBranch, title, description, labels, isDraft });
    process.stdout.write(" ".repeat(40) + "\r");
    const url = mr.web_url ?? "";
    console.log(
      boxen(
        chalk.bold(p.green("✔  Merge request created")) + (url ? "\n  " + p.cyan(url) : ""),
        { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#4ade80" },
      ),
    );
    console.log();
    if (url) {
      const openIt = await confirm({ message: p.white("Open in browser?"), default: false, theme: THEME });
      console.log();
      if (openIt) openUrl(url);
    }
  } catch (e) {
    process.stdout.write(" ".repeat(40) + "\r");
    const msg = (e.message ?? "").toLowerCase();
    const isExisting = msg.includes("already exists") || msg.includes("open merge request");
    console.log(
      boxen(
        isExisting
          ? p.teal("◉  An MR for this branch already exists")
          : chalk.bold(p.red("Failed to create MR")) + "\n\n" + p.muted((e.message ?? "").slice(0, 120)),
        {
          padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round",
          borderColor: isExisting ? "#4ecdc4" : "#f87171"
        },
      ),
    );
    console.log();
  }
}

// ── Epic bulk MR creation ─────────────────────────────────────────────────────
// Creates MRs in parallel for all issues that have a primary branch + local repo.
async function cmdEpicMr(epicIssues, glabRepos, portalConfig, { autoConfirm = false } = {}) {
  const primaryBranches = loadConfig().portal?.primaryBranches ?? {};

  const candidates = epicIssues.map((issue) => {
    const ref = issue.references?.full ?? "";
    const [projectPath, localIid] = ref.split("#");
    const primary = primaryBranches[issueConfigKey(issue)] ?? null;
    const localRepo = findLocalRepo(glabRepos, projectPath);
    return { issue, localIid, projectPath, primary, localRepo };
  });

  const ready = candidates.filter((c) => c.primary && c.localRepo);
  const skipped = candidates.filter((c) => !c.primary || !c.localRepo);

  if (ready.length === 0) {
    console.log("  " + p.muted("No issues ready. Set primary branches first.\n"));
    return;
  }

  // Show skipped repos as info before the picker
  if (skipped.length > 0) {
    const maxSkip = Math.max(...skipped.map((c) => (c.localRepo?.name ?? c.projectPath.split("/").pop()).length), 4);
    for (const c of skipped) {
      const name = (c.localRepo?.name ?? c.projectPath.split("/").pop()).padEnd(maxSkip);
      const reason = !c.primary ? "no primary set" : "no local repo";
      console.log("  " + p.muted("○") + "  " + p.muted(name + "  " + reason));
    }
    console.log();
  }

  let selectedReady;

  if (autoConfirm) {
    // Non-interactive: use all ready repos without showing the picker
    selectedReady = ready;
    if (skipped.length > 0) {
      console.log();
    }
  } else {
  // Multi-select: all ready repos pre-selected, space to toggle, Esc to go back
  const choices = ready.map((c) => ({
    name: c.localRepo.name,
    value: c.localRepo.name,
    message: chalk.bold(p.white(c.localRepo.name)) + "  " + colorBranch(c.primary),
    hint: "",
    enabled: true,  // pre-select all
  }));

  const selectedNames = await enquirer.autocomplete({
    name: "repos",
    message: "Select repos to create MRs for:",
    multiple: true,
    initial: 0,
    limit: 12,
    choices,
    symbols: { indicator: { on: "◉", off: "◯" } },
    footer() { return p.muted("space to toggle · type to filter · enter to confirm · esc to go back"); },
    suggest(input = "", allChoices = []) {
      const term = (input ?? "").toLowerCase().trim();
      const selected = allChoices.filter((c) => c.enabled);
      const unselected = allChoices.filter((c) => !c.enabled);
      const filtered = term ? unselected.filter((c) => c.value.toLowerCase().includes(term)) : unselected;
      return [...selected, ...filtered];
    },
  }).catch(() => "__back__");

  console.log();
  if (selectedNames === "__back__" || !Array.isArray(selectedNames) || selectedNames.length === 0) {
    if (selectedNames !== "__back__") console.log("  " + p.muted("Nothing selected.\n"));
    return;
  }

  selectedReady = selectedNames
    .map((name) => ready.find((c) => c.localRepo.name === name))
    .filter(Boolean);
  } // end autoConfirm / interactive split

  // Shared options — prompt once for all (skip prompts when auto-confirming)
  const targetBranch = autoConfirm
    ? (portalConfig.defaultBaseBranch ?? "develop")
    : (await enquirer.prompt({
        type: "input",
        name: "targetBranch",
        message: p.white("Target branch") + p.muted(" (for all):"),
        initial: portalConfig.defaultBaseBranch ?? "develop",
        validate: (v) => v.trim() !== "" || "Required",
      })).targetBranch;

  const labels = autoConfirm
    ? (portalConfig.defaultLabels ?? "")
    : await input({
        message: p.white("Labels") + p.muted(" (optional, applied to all):"),
        default: portalConfig.defaultLabels ?? "",
        theme: { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
      });

  const isDraft = autoConfirm
    ? false
    : await confirm({ message: p.white("Mark all as") + p.muted(" Draft?"), default: false, theme: THEME });

  const pushFirst = autoConfirm
    ? true
    : await confirm({ message: p.white("Push branches") + p.muted(" first?"), default: true, theme: THEME });

  console.log();

  const confirmed = autoConfirm
    ? true
    : await confirm({
        message: p.white("Create ") + p.cyan(String(selectedReady.length)) + p.white(` MR${selectedReady.length !== 1 ? "s" : ""}?`),
        default: true, theme: THEME,
      });
  console.log();
  if (!confirmed) return;

  // Parallel execution via Listr
  const results = [];
  const numWidth = String(selectedReady.length).length;


  const listTasks = new Listr(
    selectedReady.map(({ issue, localIid, localRepo, primary }, i) => {
      const idx = p.muted(`[${String(i + 1).padStart(numWidth)}/${selectedReady.length}]`);
      return {
        title: idx + "  " + chalk.bold(p.white(localRepo.name)) +
          "  " + colorBranch(primary) + p.muted(" → ") + colorBranch(targetBranch),
        task: async (_, task) => {
          try {
            if (pushFirst) {
              await execFileAsync("git", ["push", "-u", "origin", primary], { cwd: localRepo.repo }).catch(() => { });
            }
            const mr = await createMrViaApi(issue.references?.full?.split("#")[0] ?? "", {
              sourceBranch: primary, targetBranch, title: issue.title, description: "", labels, isDraft,
            });
            const url = mr.web_url ?? "";
            results.push({ name: localRepo.name, ok: true, url, existing: false });
            task.title = idx + "  " + chalk.bold(p.white(localRepo.name)) + "  " + p.green("✔") + (url ? "  " + p.cyan(url) : "");
          } catch (e) {
            const msg = (e.message ?? "").toLowerCase();
            if (msg.includes("already exists") || msg.includes("open merge request")) {
              results.push({ name: localRepo.name, ok: true, url: "", existing: true });
              task.title = idx + "  " + chalk.bold(p.white(localRepo.name)) + "  " + p.teal("◉  already exists");
            } else {
              const clean = (e.message ?? "").replace(/\n/g, " ").trim();
              results.push({ name: localRepo.name, ok: false, url: "", existing: false, msg: clean });
              task.title = idx + "  " + chalk.bold(p.white(localRepo.name)) + "  " + p.red("✘  ") + p.muted(clean.slice(0, 65));
              throw new Error(clean);
            }
          }
        },
      };
    }),
    { concurrent: true, exitOnError: false },
  );

  await listTasks.run().catch(() => { });
  console.log();

  const opened = results.filter((r) => r.ok && !r.existing);
  const existing = results.filter((r) => r.ok && r.existing);
  const failed = results.filter((r) => !r.ok);
  const sep = p.slate("   ·   ");
  const parts = [];
  if (opened.length) parts.push(chalk.bold(p.green(`✔  ${opened.length} opened`)));
  if (existing.length) parts.push(p.teal(`◉  ${existing.length} already existed`));
  if (failed.length) parts.push(p.red(`✘  ${failed.length} failed`));
  console.log(
    boxen(
      parts.join(sep) + "\n" + p.muted(`${selectedReady.length} repo${selectedReady.length !== 1 ? "s" : ""} processed`),
      { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: failed.length > 0 ? "#f87171" : "#4ade80" },
    ),
  );

  const successful = results.filter((r) => r.ok && r.url);
  if (successful.length > 0) {
    const maxN = Math.max(...successful.map((r) => r.name.length));
    console.log();
    console.log("  " + chalk.bold(p.white("Merge Requests")));
    console.log("  " + p.dim("─".repeat(50)));
    for (const r of successful) {
      console.log(
        "  " + (r.existing ? p.teal("◉") : p.green("✔")) +
        "  " + chalk.bold(p.white(r.name.padEnd(maxN))) + "  " + p.cyan(r.url),
      );
    }
  }
  console.log();
}

// ── Repo matcher ──────────────────────────────────────────────────────────────
// Finds a local glabRepo entry for a given GitLab issue projectPath.
// Tier 1: exact full path match (fast, precise).
// Tier 2: fallback by folder name — handles cases where the local remote URL
//         has a different slug than the GitLab project name (e.g. renamed repos).
function findLocalRepo(glabRepos, projectPath) {
  const exact = glabRepos.find(
    (r) => r.projectPath.toLowerCase() === (projectPath ?? "").toLowerCase(),
  );
  if (exact) return exact;

  const nameSegment = (projectPath ?? "").split("/").pop().toLowerCase();
  return glabRepos.find((r) => basename(r.repo).toLowerCase() === nameSegment) ?? null;
}

// ── Epic checkout ──────────────────────────────────────────────────────────────
// Checks out the primary branch for each issue's local repo.
// If a primary branch is not yet set, asks the user to pick one first.

async function cmdEpicCheckout(epicIssues, glabRepos, { autoConfirm = false } = {}) {
  // Build tasks: match each issue to a local repo by project path
  const seen = new Map(); // projectPath → task (deduplicate; last issue wins)
  const tasks = [];

  for (const issue of epicIssues) {
    const ref = issue.references?.full ?? "";
    if (!ref) continue;
    const [projectPath, localIid] = ref.split("#");

    const localRepo = findLocalRepo(glabRepos, projectPath);

    if (!localRepo) continue;

    const entry = { issue, localRepo, localIid, projectPath, configKey: issueConfigKey(issue) };
    if (!seen.has(projectPath)) tasks.push(entry);
    seen.set(projectPath, entry);
  }

  if (tasks.length === 0) {
    console.log("  " + p.muted("No local repos matched the issues in this epic.\n"));
    return;
  }

  // Phase 1 — resolve primaries; ask for any that are missing
  const checkouts = []; // { localRepo, branchName }

  for (const { issue, localRepo, localIid, projectPath, configKey } of tasks) {
    let primary = (loadConfig().portal?.primaryBranches ?? {})[configKey] ?? null;

    if (!primary) {
      // No primary set — fetch branches and ask
      console.log(
        "  " + p.yellow("○") + "  " + p.white(localRepo.name) +
        p.muted("  #" + localIid + " — no primary branch set"),
      );
      console.log();

      process.stdout.write("  " + p.muted("Loading branches…\r"));
      const branches = await fetchIssueBranches(projectPath, localIid);
      process.stdout.write(" ".repeat(40) + "\r");

      if (branches.length === 0) {
        console.log("  " + p.muted("  No branches found for #" + localIid + " — skipping.\n"));
        continue;
      }

      const picked = await search({
        message:
          p.white("Primary branch") + p.muted(" for ") +
          p.white(localRepo.name) + p.muted(" #" + localIid + ":"),
        source: (val) => {
          const term = (val ?? "").toLowerCase().trim();
          return [
            { value: null, name: p.muted("— skip —"), description: p.muted("don't checkout this repo") },
            ...branches
              .filter((b) => !term || b.name.toLowerCase().includes(term))
              .map((b) => ({
                value: b.name,
                name: colorBranch(b.name),
                description: (b.commit?.committed_date ?? "").slice(0, 10),
              })),
          ];
        },
        theme: THEME,
      });
      console.log();

      if (!picked) continue;

      // Save as primary
      primary = picked;
      const fresh = loadConfig();
      const pb = { ...(fresh.portal?.primaryBranches ?? {}), [configKey]: primary };
      saveConfig({ ...fresh, portal: { ...fresh.portal, primaryBranches: pb } });
    }

    checkouts.push({ localRepo, branchName: primary });
  }

  if (checkouts.length === 0) {
    console.log("  " + p.muted("Nothing to checkout.\n"));
    return;
  }

  // Phase 2 — preview & confirm
  console.log(
    boxen(
      checkouts
        .map(({ localRepo, branchName }) =>
          "  " + p.white(localRepo.name.padEnd(24)) + colorBranch(branchName),
        )
        .join("\n"),
      {
        padding: { top: 1, bottom: 1, left: 1, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
        title: p.muted(" checkout preview "),
        titleAlignment: "right",
      },
    ),
  );
  console.log();

  const confirmed = autoConfirm
    ? true
    : await confirm({
        message: p.white("Checkout ") + p.cyan(String(checkouts.length)) + p.white(" repo" + (checkouts.length !== 1 ? "s" : "") + "?"),
        default: true,
        theme: THEME,
      });
  console.log();
  if (!confirmed) return;

  // Phase 3 — execute git switch
  for (const { localRepo, branchName } of checkouts) {
    try {
      await execFileAsync("git", ["switch", branchName], { cwd: localRepo.repo });
      console.log(
        "  " + p.green("✔") + "  " + p.white(localRepo.name.padEnd(24)) + colorBranch(branchName),
      );
    } catch (e) {
      const msg = ((e.stderr || e.message || "").toString().split("\n")[0] ?? "").trim();
      console.log(
        "  " + p.red("✖") + "  " + p.white(localRepo.name.padEnd(24)) + p.muted(msg.slice(0, 55)),
      );
    }
  }
  console.log();
}

// ── Epic CR review ────────────────────────────────────────────────────────────
// Runs `cr --base <primaryBranch>` sequentially in each issue's local repo.
// Uses spawn with stdio:inherit so cr's rich output flows directly to terminal.
async function cmdEpicCrReview(epicIssues, glabRepos, portalConfig = {}) {
  const baseBranch = portalConfig.defaultBaseBranch ?? "develop";
  const primaryBranches = loadConfig().portal?.primaryBranches ?? {};

  const candidates = epicIssues.map((issue) => {
    const ref = issue.references?.full ?? "";
    const [projectPath] = ref.split("#");
    const primary = primaryBranches[issueConfigKey(issue)] ?? null;
    const localRepo = findLocalRepo(glabRepos, projectPath);
    return { issue, projectPath, primary, localRepo };
  });

  const ready = candidates.filter((c) => c.primary && c.localRepo);
  const skipped = candidates.filter((c) => !c.primary || !c.localRepo);

  if (ready.length === 0) {
    console.log("  " + p.muted("No issues ready for review. Set primary branches first.\n"));
    return;
  }

  if (skipped.length > 0) {
    const maxSkip = Math.max(...skipped.map((c) => (c.localRepo?.name ?? c.projectPath.split("/").pop()).length), 4);
    for (const c of skipped) {
      const name = (c.localRepo?.name ?? c.projectPath.split("/").pop()).padEnd(maxSkip);
      const reason = !c.primary ? "no primary set" : "no local repo";
      console.log("  " + p.muted("○") + "  " + p.muted(name + "  " + reason));
    }
    console.log();
  }

  console.log(
    boxen(
      ready
        .map(({ localRepo, primary }) =>
          "  " + p.white(localRepo.name.padEnd(24)) + colorBranch(primary),
        )
        .join("\n"),
      {
        padding: { top: 1, bottom: 1, left: 1, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
        title: p.muted(" cr review preview "),
        titleAlignment: "right",
      },
    ),
  );
  console.log();

  const confirmed = await confirm({
    message: p.white("Run ") + p.yellow("cr") + p.white(" review on ") + p.cyan(String(ready.length)) + p.white(` repo${ready.length !== 1 ? "s" : ""}?`),
    default: true,
    theme: THEME,
  });
  console.log();
  if (!confirmed) return;

  // Detect which binary to use (cr alias or full coderabbit name)
  const crBin = (() => { try { execSync("cr --version", { stdio: "pipe" }); return "cr"; } catch { return "coderabbit"; } })();

  const numWidth = String(ready.length).length;
  const results = [];

  for (let i = 0; i < ready.length; i++) {
    const { localRepo, primary } = ready[i];
    const idx = `[${String(i + 1).padStart(numWidth)}/${ready.length}]`;

    // Print a header so the user knows which repo is being reviewed
    console.log(
      boxen(
        p.muted(idx) + "  " + chalk.bold(p.white(localRepo.name)) + "  " + colorBranch(primary),
        { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#334155" },
      ),
    );
    console.log();

    // 1. Switch to the primary (feature) branch
    try {
      execSync(`git switch ${primary}`, { cwd: localRepo.repo, stdio: "pipe" });
    } catch {
      // already on branch or switch failed — continue anyway
    }

    // 2. Run cr --base <defaultBaseBranch> --prompt-only
    //    This reviews all commits on primaryBranch that aren't on baseBranch
    const exitCode = await new Promise((resolve) => {
      const child = spawn(crBin, ["--base", baseBranch, "--prompt-only"], {
        cwd: localRepo.repo,
        stdio: "inherit",
        shell: false,
      });
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(1));
    });

    const ok = exitCode === 0;
    results.push({ name: localRepo.name, ok });
    console.log(
      "  " + (ok ? p.green("✔") : p.red("✘")) +
      "  " + chalk.bold(p.white(localRepo.name)) +
      "  " + (ok ? p.green("review complete") : p.red("review failed")) + "\n",
    );
  }

  // Final summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const summaryParts = [];
  if (passed) summaryParts.push(chalk.bold(p.green(`✔  ${passed} complete`)));
  if (failed) summaryParts.push(p.red(`✘  ${failed} failed`));
  console.log(
    boxen(
      summaryParts.join(p.slate("   ·   ")) + "\n" + p.muted(`${ready.length} repo${ready.length !== 1 ? "s" : ""} reviewed`),
      { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: failed > 0 ? "#f87171" : "#4ade80" },
    ),
  );
  console.log();
}

// ── Main portal command ────────────────────────────────────────────────────────

export async function cmdPortal(repos, {
  settings    = false,
  // ── non-interactive opts ────────────────────────────────────────────────────────────
  epic:             cliEpic      = null,  // --epic <iid>
  checkout:         cliCheckout  = false, // --checkout
  createMr:         cliCreateMr  = false, // --create-mr
  createIssue:      cliCreateIssue = false, // --create-issue
  review:           cliReview    = false, // --review
  // shared
  target:           cliTarget       = null, // --target
  title:            cliTitle        = null, // --title (MR)
  description:      cliDescription  = null,
  labels:           cliLabels       = null,
  draft:            cliDraft        = false,
  noPush:           cliNoPush       = false,
  // issue creation
  issueProject:     cliIssueProject     = null,
  issueTitle:       cliIssueTitle       = null,
  issueDescription: cliIssueDescription = null,
  issueLabels:      cliIssueLabels      = null,
  branchName:       cliBranchName       = null,
  baseBranch:       cliBaseBranch       = null,
  // auto-confirm
  yes:              autoConfirm         = false,
} = {}) {
  // Detect CodeRabbit CLI once up front
  const crAvailable = isCrAvailable();
  const config = loadConfig();
  const portalConfig = config.portal ?? {};

  try {
    execSync("glab version", { encoding: "utf8", stdio: "pipe" });
  } catch {
    const isMac   = process.platform === "darwin";
    const isWin   = process.platform === "win32";
    const isLinux = process.platform === "linux";

    const platform = isMac ? "macOS" : isWin ? "Windows" : isLinux ? "Linux" : null;

    const installLines = isMac
      ? p.muted("  brew     ") + p.cyan("brew install glab") + "\n" +
        p.muted("  MacPorts ") + p.cyan("sudo port install glab") + "\n" +
        p.muted("  asdf     ") + p.cyan("asdf plugin add glab && asdf install glab latest")
      : isWin
      ? p.muted("  winget   ") + p.cyan("winget install glab.glab") + "\n" +
        p.muted("  choco    ") + p.cyan("choco install glab") + "\n" +
        p.muted("  scoop    ") + p.cyan("scoop install glab") + "\n" +
        p.muted("  brew     ") + p.cyan("brew install glab") + p.muted("  (via WSL)")
      : isLinux
      ? p.muted("  brew     ") + p.cyan("brew install glab") + "\n" +
        p.muted("  snap     ") + p.cyan("sudo snap install glab && sudo snap connect glab:ssh-keys") + "\n" +
        p.muted("  apt      ") + p.cyan("sudo apt install glab") + p.muted("  (WakeMeOps repo)") + "\n" +
        p.muted("  pacman   ") + p.cyan("pacman -S glab") + "\n" +
        p.muted("  dnf      ") + p.cyan("dnf install glab")
      : p.muted("  ") + p.cyan("https://gitlab.com/gitlab-org/cli#installation");

    console.log(
      boxen(
        chalk.bold(p.red("glab not found")) + "\n\n" +
        p.white((platform ? `gsync requires the GitLab CLI. Install it on ${platform}:\n\n` : "gsync requires the GitLab CLI:\n\n")) +
        installLines + "\n\n" +
        p.white("Then authenticate:\n\n") +
        p.muted("  ") + p.cyan("glab auth login") + p.muted("   (follow the prompts to connect your GitLab account)") + "\n" +
        p.muted("  docs  ") + p.cyan("https://gitlab.com/gitlab-org/cli#installation"),
        {
          padding: { top: 1, bottom: 1, left: 3, right: 3 },
          borderStyle: "round",
          borderColor: "#f87171",
          title: p.red(" missing dependency: glab "),
          titleAlignment: "center",
        },
      ),
    );
    return 1;
  }

  process.stdout.write("  " + p.muted("Authenticating…\r"));
  let user;
  try {
    user = await glabApi("/user");
    process.stdout.write(" ".repeat(40) + "\r");
  } catch (e) {
    process.stdout.write(" ".repeat(40) + "\r");
    console.log(
      boxen(
        chalk.bold(p.red("Authentication failed")) + "\n\n" +
        p.muted("Run ") + p.cyan("glab auth login") + p.muted(" to authenticate.\n") +
        p.muted(e.message.slice(0, 80)),
        {
          padding: { top: 1, bottom: 1, left: 3, right: 3 },
          borderStyle: "round",
          borderColor: "#f87171",
        },
      ),
    );
    return 1;
  }

  let group = portalConfig.group;
  if (!group) {
    const rawGroup = detectGroupFromRepos(repos);
    if (rawGroup) {
      process.stdout.write("  " + p.muted("Detecting group…\r"));
      group = await resolveEpicGroup(rawGroup, user.username, portalConfig.epicLabelFilter);
      process.stdout.write(" ".repeat(40) + "\r");
      saveConfig({ ...config, portal: { ...portalConfig, group } });
      console.log("  " + p.muted("Group auto-detected: ") + p.white(group) + "\n");
    }
  }

  if (settings) {
    return await cmdPortalSettings(loadConfig(), group);
  }

  if (!group) {
    console.log(
      "  " + p.yellow("No GitLab group configured.") + p.muted("  Let's set it up.\n"),
    );
    return await cmdPortalSettings(loadConfig(), null);
  }

  // ── Fetch epics assigned to user via GraphQL Work Items API ───────────────────
  process.stdout.write("  " + p.muted("Loading epics…\r"));
  let epics = [];

  try {
    epics = await fetchAssignedEpics(group, user.username, portalConfig.epicLabelFilter);
    process.stdout.write(" ".repeat(40) + "\r");
  } catch (e) {
    process.stdout.write(" ".repeat(40) + "\r");
    console.log(
      boxen(
        chalk.bold(p.red("Failed to load epics")) + "\n\n" + p.muted(e.message.slice(0, 100)),
        {
          padding: { top: 0, bottom: 0, left: 2, right: 2 },
          borderStyle: "round",
          borderColor: "#f87171",
        },
      ),
    );
    return 1;
  }

  // No epics in configured group — probe ancestor groups (handles stale config)
  if (epics.length === 0 && group.includes("/")) {
    process.stdout.write("  " + p.muted("Checking parent groups for epics…\r"));
    const betterGroup = await resolveEpicGroup(group, user.username, portalConfig.epicLabelFilter);
    process.stdout.write(" ".repeat(60) + "\r");

    if (betterGroup !== group) {
      group = betterGroup;
      saveConfig({ ...loadConfig(), portal: { ...(loadConfig().portal ?? {}), group } });
      try {
        epics = await fetchAssignedEpics(group, user.username, portalConfig.epicLabelFilter);
      } catch { }
    }
  }

  // Portal header — rendered after group is fully resolved
  console.log(
    boxen(
      p.muted("user") + "  " + chalk.bold(p.white(user.username)) +
      "   " + p.muted("group") + "  " + chalk.bold(p.cyan(group)),
      {
        padding: { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
        title: p.muted(" GitLab Development Portal "),
        titleAlignment: "center",
      },
    ),
  );
  console.log();

  const glabRepos = (
    await Promise.all(
      repos.map(async (repo) => {
        const remote = getRemoteUrl(repo);
        if (!isGitLabRemote(remote)) return null;
        const branch = await getCurrentBranch(repo);
        const projectPath = getProjectPath(remote);
        return { repo, name: basename(repo), remote, projectPath, branch };
      }),
    )
  ).filter(Boolean);

  // ── Non-interactive dispatch ─────────────────────────────────────────────────
  // When any action flag is set, resolve the epic (if --epic provided) and dispatch
  // directly without showing any menus.
  const hasCliAction = cliEpic || cliCheckout || cliCreateMr || cliCreateIssue || cliReview;
  if (hasCliAction) {
    let resolvedEpic = null;

    if (cliEpic) {
      resolvedEpic = epics.find((e) => String(e.iid) === String(cliEpic));
      if (!resolvedEpic) {
        console.log(
          boxen(
            chalk.bold(p.red(`Epic #${cliEpic} not found`)) + "\n" +
            p.muted("Available IIDs: ") + epics.map((e) => `#${e.iid}`).join(", "),
            { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#f87171" },
          ),
        );
        return 1;
      }
    }

    // --create-mr via portal (non-interactive MR command)
    if (cliCreateMr && !cliEpic) {
      return await cmdMr(repos, {
        target:      cliTarget,
        title:       cliTitle,
        description: cliDescription,
        labels:      cliLabels,
        draft:       cliDraft,
        noPush:      cliNoPush,
        yes:         autoConfirm,
      });
    }

    if (resolvedEpic) {
      // Fetch issues for the resolved epic
      process.stdout.write("  " + p.muted("Loading issues…\r"));
      const epicIssues = await fetchEpicIssues(group, resolvedEpic.iid);
      process.stdout.write(" ".repeat(40) + "\r");

      if (cliCheckout) {
        return await cmdEpicCheckout(epicIssues, glabRepos, { autoConfirm });
      }

      if (cliReview) {
        if (!crAvailable) {
          console.log(
            boxen(
              chalk.bold(p.yellow("CodeRabbit CLI not found")) + "\n\n" +
              p.muted("Install with: ") + p.cyan("curl -fsSL https://cli.coderabbit.ai/install.sh | sh") + "\n" +
              p.muted("Then authenticate: ") + p.cyan("cr auth login"),
              {
                padding: { top: 1, bottom: 1, left: 3, right: 3 },
                borderStyle: "round",
                borderColor: "#fbbf24",
                title: p.yellow(" missing dependency "),
                titleAlignment: "center",
              },
            ),
          );
          return 1;
        }
        return await cmdEpicCrReview(epicIssues, glabRepos, portalConfig);
      }

      if (cliCreateMr) {
        // Bulk epic MR — override shared options in portalConfig for non-interactive
        const mergedPortalConfig = {
          ...portalConfig,
          ...(cliTarget  ? { defaultBaseBranch: cliTarget } : {}),
          ...(cliLabels  ? { defaultLabels: cliLabels }     : {}),
        };
        return await cmdEpicMr(epicIssues, glabRepos, mergedPortalConfig, { autoConfirm });
      }

      if (cliCreateIssue) {
        if (!cliIssueProject) {
          console.log(p.red("  --issue-project is required for non-interactive issue creation.\n"));
          return 1;
        }
        if (!cliIssueTitle) {
          console.log(p.red("  --issue-title is required for non-interactive issue creation.\n"));
          return 1;
        }

        const projectChoice = glabRepos.find(
          (r) => r.name === cliIssueProject || r.projectPath === cliIssueProject,
        );
        if (!projectChoice) {
          console.log(p.red(`  Project "${cliIssueProject}" not found in local GitLab repos.\n`));
          return 1;
        }

        // Resolve epic ID
        let epicId = null;
        try {
          const epicRest = await glabApi(`groups/${encodeURIComponent(group)}/epics/${resolvedEpic.iid}`);
          epicId = epicRest.id ?? null;
        } catch { }

        const issueFields = {
          title: cliIssueTitle.trim(),
          ...(epicId ? { epic_id: epicId } : { epic_iid: resolvedEpic.iid }),
        };
        if (cliIssueDescription?.trim()) issueFields.description = cliIssueDescription.trim();
        const effectiveLabels = cliIssueLabels ?? portalConfig.defaultLabels ?? null;
        if (effectiveLabels?.trim()) issueFields.labels = effectiveLabels.trim();
        if (portalConfig.defaultMilestone?.id) issueFields.milestone_id = portalConfig.defaultMilestone.id;

        const enc = encodeURIComponent(projectChoice.projectPath);
        process.stdout.write("  " + p.muted("Creating issue…\r"));
        let issue;
        try {
          issue = await glabApi(`projects/${enc}/issues`, { method: "POST", fields: issueFields });
          process.stdout.write(" ".repeat(40) + "\r");
        } catch (e) {
          process.stdout.write(" ".repeat(40) + "\r");
          console.log(
            boxen(
              chalk.bold(p.red("Failed to create issue")) + "\n\n" + p.muted(e.message.slice(0, 100)),
              { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#f87171" },
            ),
          );
          return 1;
        }

        console.log(
          boxen(
            chalk.bold(p.green(`✔  Issue #${issue.iid} created`)) + "\n  " + p.muted(issue.web_url ?? ""),
            { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#4ade80" },
          ),
        );
        console.log();

        // Non-interactive branch creation if --branch-name is provided
        if (cliBranchName) {
          const baseBr = cliBaseBranch ?? portalConfig.defaultBaseBranch ?? "develop";
          process.stdout.write("  " + p.muted("Creating branch…\r"));
          try {
            await glabApi(`projects/${enc}/repository/branches`, {
              method: "POST",
              fields: { branch: cliBranchName.trim(), ref: baseBr.trim() },
            });
            process.stdout.write(" ".repeat(40) + "\r");
            console.log(
              boxen(
                chalk.bold(p.green("✔  Branch created")) + "  " + colorBranch(cliBranchName.trim()),
                { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#4ade80" },
              ),
            );
            // Auto-set as primary
            const cfgNow = loadConfig();
            const pbNow = { ...(cfgNow.portal?.primaryBranches ?? {}), [`${projectChoice.projectPath}#${issue.iid}`]: cliBranchName.trim() };
            saveConfig({ ...cfgNow, portal: { ...cfgNow.portal, primaryBranches: pbNow } });
          } catch (e) {
            process.stdout.write(" ".repeat(40) + "\r");
            console.log(
              boxen(
                chalk.bold(p.red("Branch creation failed")) + "\n\n" + p.muted(e.message.slice(0, 80)),
                { padding: { top: 0, bottom: 0, left: 2, right: 2 }, borderStyle: "round", borderColor: "#f87171" },
              ),
            );
          }
          console.log();
        }

        return 0;
      }
    }

    // Fallthrough: --epic was given but no action flag — just print the epic's issues
    if (resolvedEpic) {
      process.stdout.write("  " + p.muted("Loading issues…\r"));
      const epicIssues = await fetchEpicIssues(group, resolvedEpic.iid);
      process.stdout.write(" ".repeat(40) + "\r");
      const pb = loadConfig().portal?.primaryBranches ?? {};
      console.log(p.white(`  Epic #${resolvedEpic.iid}: `) + chalk.bold(p.cyan(resolvedEpic.title)) + "\n");
      printEpicIssues(epicIssues, pb);
      return 0;
    }
  }

  // ── Portal home menu ─────────────────────────────────────────────────────────
  portalHome: while (true) {
    const section = await select({
      message: p.white("GitLab Portal:"),
      choices: [
        {
          value: "epics",
          name: chalk.hex("#FC6D26")("◈  Epics") + p.muted("   browse assigned epics, create issues & branches"),
          description: p.muted("view epics, manage issues, checkout primary branches"),
        },
        {
          value: "mr",
          name: p.purple("⎇  Merge Requests") + p.muted("   create MRs for local branches"),
          description: p.muted("open merge requests via glab CLI"),
        },
        {
          value: "__back__",
          name: p.yellow("← Go back"),
          description: p.muted("return to mode selection"),
        },
      ],
      theme: THEME,
    });
    console.log();

    if (section === "__back__") return "__back__";

    if (section === "mr") {
      const r = await cmdMr(repos, {
        target:      cliTarget,
        title:       cliTitle,
        description: cliDescription,
        labels:      cliLabels,
        draft:       cliDraft,
        noPush:      cliNoPush,
        yes:         autoConfirm,
      });
      if (r !== "__back__") return r;
      continue portalHome;
    }

    // ── Epics section ───────────────────────────────────────────────────────────
    if (epics.length === 0) {
      console.log(
        boxen(
          p.yellow("No open epics assigned to you") + p.muted(" in ") + p.white(group),
          {
            padding: { top: 0, bottom: 0, left: 2, right: 2 },
            borderStyle: "round",
            borderColor: "#fbbf24",
          },
        ),
      );
      console.log();
      continue portalHome;
    }

    if (glabRepos.length === 0) {
      console.log(p.yellow("  No local GitLab repositories found in scope.\n"));
      continue portalHome;
    }

    portalFlow: while (true) {
      // 1. Select epic
      const epic = await search({
        message: p.white("Epic:"),
        source: (val) => {
          const term = (val ?? "").toLowerCase().trim();
          return [
            { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to portal home") },
            ...epics
              .filter((e) => !term || e.title.toLowerCase().includes(term))
              .map((e) => ({
                value: e,
                name: chalk.bold(p.white(e.title)),
                description:
                  p.muted(`#${e.iid}`) +
                  (e.labels.length > 0 ? "  " + e.labels.map((l) => colorLabel(l)).join(p.muted("  ")) : ""),
              })),
          ];
        },
        theme: THEME,
      });
      if (epic === "__back__") break portalFlow;
      console.log();

      // 2. Issue loop — show existing issues then action menu
      issueLoop: while (true) {
        // Fetch and display existing issues under this epic
        process.stdout.write("  " + p.muted("Loading issues…\r"));
        const epicIssues = await fetchEpicIssues(group, epic.iid);
        process.stdout.write(" ".repeat(40) + "\r");

        const primaryBranches = loadConfig().portal?.primaryBranches ?? {};
        printEpicIssues(epicIssues, primaryBranches);

        // Action menu
        const hasIssues = epicIssues.length > 0;
        const hasLocalHit = epicIssues.some((i) => {
          const [pp] = (i.references?.full ?? "").split("#");
          return findLocalRepo(glabRepos, pp) !== null;
        });

        const action = await select({
          message: p.white("Action:"),
          choices: [
            ...(hasIssues ? [{
              value: "view",
              name: p.cyan("↵ View issue"),
              description: p.muted("see branches & set primary branch"),
            }] : []),
            ...(hasIssues && hasLocalHit ? [{
              value: "checkout",
              name: p.teal("⎇  Checkout to primary branches"),
              description: p.muted("switch local repos to their primary branches"),
            }] : []),
            ...(hasIssues && hasLocalHit ? [{
              value: "epicMr",
              name: p.purple("⊞  Create MRs for epic"),
              description: p.muted("open a merge request per issue from each primary branch"),
            }] : []),
            ...(hasIssues && hasLocalHit && crAvailable ? [{
              value: "review",
              name: p.yellow("◎  Review with CodeRabbit"),
              description: p.muted("run cr --base <primary> on each issue's local repo"),
            }] : []),
            {
              value: "create",
              name: p.green("+ Create new issue"),
              description: p.muted("add a new issue linked to this epic"),
            },
            {
              value: "openEpic",
              name: p.teal("⊕  View epic in GitLab"),
              description: p.muted(epic.web_url ?? ""),
            },
            {
              value: "__back__",
              name: p.yellow("← Back to epics"),
              description: p.muted("select a different epic"),
            },
          ],
          theme: THEME,
        });
        console.log();

        if (action === "__back__") continue portalFlow;

        if (action === "openEpic") {
          openUrl(epic.web_url);
          continue issueLoop;
        }

        // Checkout all repos to their primary branches
        if (action === "checkout") {
          await cmdEpicCheckout(epicIssues, glabRepos, { autoConfirm });
          continue issueLoop;
        }

        // Review all issues in this epic with CodeRabbit
        if (action === "review") {
          await cmdEpicCrReview(epicIssues, glabRepos, portalConfig);
          continue issueLoop;
        }

        // Create MRs for all issues in this epic
        if (action === "epicMr") {
          await cmdEpicMr(epicIssues, glabRepos, portalConfig, { autoConfirm });
          continue issueLoop;
        }

        // View existing issue
        if (action === "view") {
          const issueChoice = await search({
            message: p.white("Select issue:"),
            source: (val) => {
              const term = (val ?? "").toLowerCase().trim();
              const pb = loadConfig().portal?.primaryBranches ?? {};
              return [
                { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to action menu") },
                ...epicIssues
                  .filter((i) => !term || i.title.toLowerCase().includes(term) || String(i.iid).includes(term))
                  .map((i) => {
                    const ref = i.references?.full ?? "";
                    const projectName = ref.split("#")[0].split("/").pop() ?? "";
                    const primary = pb[ref] ?? null;
                    return {
                      value: i,
                      name:
                        (i.state === "opened" ? p.green("● ") : p.muted("○ ")) +
                        p.white(i.title.slice(0, 48)),
                      description:
                        p.muted(projectName) +
                        (primary ? "  " + p.teal("⎇") + " " + colorBranch(primary) : ""),
                    };
                  }),
              ];
            },
            theme: THEME,
          });
          console.log();
          if (issueChoice !== "__back__") await cmdIssueView(issueChoice, glabRepos, portalConfig);
          continue issueLoop;
        }

        // 3. Select project
        const projectChoice = await search({
          message: p.white("Project:"),
          source: (val) => {
            const term = (val ?? "").toLowerCase().trim();
            return [
              { value: "__back__", name: p.yellow("← Go back"), description: p.muted("return to issue list") },
              ...glabRepos
                .filter((r) =>
                  !term ||
                  r.name.toLowerCase().includes(term) ||
                  r.projectPath.toLowerCase().includes(term),
                )
                .map((r) => ({
                  value: r,
                  name: chalk.bold(p.white(r.name)),
                  description: colorBranch(r.branch) + "  " + p.muted(r.projectPath),
                })),
            ];
          },
          theme: THEME,
        });
        if (projectChoice === "__back__") { console.log(); continue issueLoop; }
        console.log();

        // 4. Issue details
        const defaultTitle = `${epic.title} - ${projectChoice.name}`;

        // 4. Issue details — use enquirer initial so backspace works char-by-char
        const { issueTitle } = await enquirer.prompt({
          type: "input",
          name: "issueTitle",
          message: p.white("Title:"),
          initial: defaultTitle,
          validate: (v) => v.trim() !== "" || "Title cannot be empty",
        });

        const issueDesc = await input({
          message: p.white("Description") + p.muted(" (optional):"),
          theme: THEME,
        });

        const issueLabels = await input({
          message: p.white("Labels") + p.muted(" (comma separated, optional):"),
          default: portalConfig.defaultLabels ?? "",
          theme: { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
        });

        // 5. Preview
        const previewLines = [
          p.muted("  epic        ") + chalk.bold(p.white(epic.title.slice(0, 55))),
          p.muted("  project     ") + chalk.bold(p.white(projectChoice.name)),
          p.muted("  title       ") + p.white(issueTitle.slice(0, 55) + (issueTitle.length > 55 ? "…" : "")),
          issueDesc.trim()
            ? p.muted("  description ") + p.white(issueDesc.slice(0, 55) + (issueDesc.length > 55 ? "…" : ""))
            : null,
          issueLabels.trim()
            ? p.muted("  labels      ") + p.purple(issueLabels)
            : null,
          portalConfig.defaultMilestone?.title
            ? p.muted("  milestone   ") + p.teal(portalConfig.defaultMilestone.title)
            : null,
          portalConfig.defaultIteration?.id
            ? p.muted("  iteration   ") + p.cyan(
              portalConfig.defaultIteration.id === "__current__"
                ? "current iteration"
                : portalConfig.defaultIteration.title,
            )
            : null,
        ].filter(Boolean).join("\n");

        console.log();
        console.log(
          boxen(previewLines, {
            padding: { top: 1, bottom: 1, left: 2, right: 2 },
            borderStyle: "round",
            borderColor: "#334155",
            title: p.muted(" issue preview "),
            titleAlignment: "right",
          }),
        );
        console.log();

        const confirmed = await confirm({ message: p.white("Create issue?"), default: true, theme: THEME });
        if (!confirmed) { console.log(); continue issueLoop; }

        // 6. Create issue — resolve __current__ iteration to a real sprint ID
        let resolvedIterationId = portalConfig.defaultIteration?.id ?? null;
        if (resolvedIterationId === "__current__") {
          try {
            const groupEnc = encodeURIComponent(group);
            const todayUtc = new Date().toISOString().slice(0, 10);
            const activeIters = await glabApi(`groups/${groupEnc}/iterations?state=current&per_page=1`);
            const iter = Array.isArray(activeIters) ? activeIters[0] : null;
            if (iter && iter.due_date > todayUtc) {
              // Iteration is still open past today — safe to use
              resolvedIterationId = iter.id;
            } else {
              // Ends today or none found — GitLab silently drops same-day assignments,
              // so grab the next upcoming iteration instead
              const nextIters = await glabApi(`groups/${groupEnc}/iterations?state=upcoming&per_page=1`);
              const next = Array.isArray(nextIters) ? nextIters[0] : null;
              resolvedIterationId = next?.id ?? null;
            }
          } catch {
            resolvedIterationId = null;
          }
        }


        // Resolve the real classic epic ID via REST — the GraphQL WorkItems API
        // returns gid://gitlab/WorkItem/NNNN which is NOT the epic's database ID.
        // GET /groups/:group/epics/:iid returns { id: <real numeric id>, ... }.
        let epicId = null;
        try {
          const epicRest = await glabApi(`groups/${encodeURIComponent(group)}/epics/${epic.iid}`);
          epicId = epicRest.id ?? null;
        } catch {
          // If REST fetch fails (e.g. group path mismatch), fall back to iid
        }
        const issueFields = {
          title: issueTitle.trim(),
          ...(epicId ? { epic_id: epicId } : { epic_iid: epic.iid }),
        };

        if (issueDesc.trim()) issueFields.description = issueDesc.trim();
        if (issueLabels.trim()) issueFields.labels = issueLabels.trim();
        if (portalConfig.defaultMilestone?.id) issueFields.milestone_id = portalConfig.defaultMilestone.id;
        if (resolvedIterationId) issueFields.iteration_id = resolvedIterationId;

        const enc = encodeURIComponent(projectChoice.projectPath);
        process.stdout.write("  " + p.muted("Creating issue…\r"));
        let issue;
        try {
          issue = await glabApi(`projects/${enc}/issues`, { method: "POST", fields: issueFields });
          process.stdout.write(" ".repeat(40) + "\r");
        } catch (e) {
          process.stdout.write(" ".repeat(40) + "\r");
          console.log(
            boxen(
              chalk.bold(p.red("Failed to create issue")) + "\n\n" + p.muted(e.message.slice(0, 100)),
              {
                padding: { top: 0, bottom: 0, left: 2, right: 2 },
                borderStyle: "round",
                borderColor: "#f87171",
              },
            ),
          );
          console.log();
          continue issueLoop;
        }

        console.log(
          boxen(
            chalk.bold(p.green(`✔  Issue #${issue.iid} created`)) + "\n  " + p.muted(issue.web_url ?? ""),
            {
              padding: { top: 0, bottom: 0, left: 2, right: 2 },
              borderStyle: "round",
              borderColor: "#4ade80",
            },
          ),
        );
        console.log();

        // 7. Create branch
        const wantBranch = await confirm({
          message: p.white("Create branch") + p.muted(" for this issue?"),
          default: true,
          theme: THEME,
        });

        if (wantBranch) {
          const defaultBranchName = `feature/${issue.iid}-${slugify(issueTitle)}`;

          // Use enquirer's Input so `initial` goes into the edit buffer —
          // @inquirer/prompts `default` is a hint that backspace wipes instantly.
          const { branchName } = await enquirer.prompt({
            type: "input",
            name: "branchName",
            message: p.white("Branch name:"),
            initial: defaultBranchName,
            validate: (v) => v.trim() !== "" || "Branch name cannot be empty",
          });

          const { baseBranchName } = await enquirer.prompt({
            type: "input",
            name: "baseBranchName",
            message: p.white("Base branch:"),
            initial: portalConfig.defaultBaseBranch ?? "develop",
            validate: (v) => v.trim() !== "" || "Base branch cannot be empty",
          });

          process.stdout.write("  " + p.muted("Creating branch…\r"));
          try {
            await glabApi(`projects/${enc}/repository/branches`, {
              method: "POST",
              fields: { branch: branchName.trim(), ref: baseBranchName.trim() },
            });
            process.stdout.write(" ".repeat(40) + "\r");
            console.log(
              boxen(
                chalk.bold(p.green("✔  Branch created")) + "  " + colorBranch(branchName.trim()),
                {
                  padding: { top: 0, bottom: 0, left: 2, right: 2 },
                  borderStyle: "round",
                  borderColor: "#4ade80",
                },
              ),
            );
            // Auto-set the new branch as primary for this issue
            const cfgNow = loadConfig();
            const pbNow = { ...(cfgNow.portal?.primaryBranches ?? {}), [`${projectChoice.projectPath}#${issue.iid}`]: branchName.trim() };
            saveConfig({ ...cfgNow, portal: { ...cfgNow.portal, primaryBranches: pbNow } });
          } catch (e) {
            process.stdout.write(" ".repeat(40) + "\r");
            console.log(
              boxen(
                chalk.bold(p.red("Branch creation failed")) + "\n\n" + p.muted(e.message.slice(0, 80)),
                {
                  padding: { top: 0, bottom: 0, left: 2, right: 2 },
                  borderStyle: "round",
                  borderColor: "#f87171",
                },
              ),
            );
          }
        }

        console.log();
        // Loop back to issueLoop → re-fetches issues and shows action menu
      }
    } // portalFlow — user went back from epic selection, continue portalHome
  } // portalHome

  return 0;
}
