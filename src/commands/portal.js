import { basename } from "path";
import { execSync } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
import chalk from "chalk";

const execFileAsync = promisify(execFile);
import boxen from "boxen";
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
          iid title webUrl
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
async function cmdIssueView(issue) {
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

  // Set primary branch
  const primaryChoice = await search({
    message: p.white("Set primary branch:"),
    source: (val) => {
      const term = (val ?? "").toLowerCase().trim();
      return [
        {
          value: null,
          name: p.muted("— none —"),
          description: p.muted("clear primary branch"),
        },
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

async function cmdEpicCheckout(epicIssues, glabRepos) {
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

  const confirmed = await confirm({
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

// ── Main portal command ────────────────────────────────────────────────────────

export async function cmdPortal(repos, { settings = false } = {}) {
  const config = loadConfig();
  const portalConfig = config.portal ?? {};

  try {
    execSync("glab version", { encoding: "utf8", stdio: "pipe" });
  } catch {
    console.log(
      boxen(
        chalk.bold(p.red("glab not found")) + "\n\n" +
        p.muted("The GitLab CLI is required for this feature.\n") +
        p.muted("Install: ") + p.cyan("https://gitlab.com/gitlab-org/cli#installation"),
        {
          padding: { top: 1, bottom: 1, left: 3, right: 3 },
          borderStyle: "round",
          borderColor: "#f87171",
          title: p.red(" missing dependency "),
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
      const r = await cmdMr(repos);
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
          await cmdEpicCheckout(epicIssues, glabRepos);
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
          if (issueChoice !== "__back__") await cmdIssueView(issueChoice);
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

        const issueTitle = await input({
          message: p.white("Title:"),
          default: defaultTitle,
          theme: THEME,
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
            const activeIters = await glabApi(`groups/${groupEnc}/iterations?state=current&per_page=1`);
            resolvedIterationId = Array.isArray(activeIters) && activeIters[0]?.id
              ? activeIters[0].id
              : null;
          } catch {
            resolvedIterationId = null;
          }
        }

        const issueFields = { title: issueTitle.trim(), epic_iid: epic.iid };
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

          const branchName = await input({
            message: p.white("Branch name:"),
            default: defaultBranchName,
            theme: THEME,
            validate: (v) => v.trim() !== "" || "Branch name cannot be empty",
          });

          const baseBranchName = await input({
            message: p.white("Base branch:"),
            default: portalConfig.defaultBaseBranch ?? "develop",
            theme: THEME,
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
