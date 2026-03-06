import chalk from "chalk";
import boxen from "boxen";
import { input, confirm, select, search } from "@inquirer/prompts";

import { glabApi } from "../gitlab/api.js";
import { detectGroupFromRepos } from "../gitlab/helpers.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { expandBranchTemplate } from "../git/templates.js";
import { p, THEME } from "../ui/theme.js";

// ── Shared UI helpers ──────────────────────────────────────────────────────────

function printSectionHeader(title, subtitle) {
  console.log(
    boxen(
      chalk.bold(p.white(title)) + (subtitle ? "\n" + p.muted(subtitle) : ""),
      {
        padding:     { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle: "round",
        borderColor: "#334155",
      },
    ),
  );
  console.log();
}

function printSaved() {
  console.log();
  console.log(
    boxen(chalk.bold(p.green("✔  Settings saved")), {
      padding:     { top: 0, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "#4ade80",
    }),
  );
  console.log();
}

// ── Portal settings ────────────────────────────────────────────────────────────

const ITER_CURRENT = "__current__";

function iterLabel(it) {
  return (it.title && it.title.trim())
    ? it.title.trim()
    : `Sprint #${it.iid}  ${it.start_date ?? ""}${it.due_date ? " → " + it.due_date : ""}`.trim();
}

export async function cmdPortalSettings(config, autoGroup) {
  printSectionHeader("Portal Settings", "GitLab group, epic filter & issue creation defaults");

  const W = 22; // label column width
  const val = (v, color = p.cyan) => v ? color(v) : p.dim("none");

  // Each field edits & saves independently — loop until Done
  while (true) {
    const pc = loadConfig().portal ?? {};

    const iterVal = pc.defaultIteration?.id
      ? (pc.defaultIteration.id === ITER_CURRENT ? p.teal("★ current sprint") : p.cyan(pc.defaultIteration.title ?? "set"))
      : p.dim("none");

    const field = await select({
      message: p.white("Edit:"),
      choices: [
        {
          value: "group",
          name:  p.muted("Group path".padEnd(W)) + val(pc.group),
        },
        {
          value: "epicLabel",
          name:  p.muted("Epic filter label".padEnd(W)) + val(pc.epicLabelFilter, p.purple),
        },
        {
          value: "milestone",
          name:  p.muted("Default milestone".padEnd(W)) + val(pc.defaultMilestone?.title, p.teal),
        },
        {
          value: "iteration",
          name:  p.muted("Default iteration".padEnd(W)) + iterVal,
        },
        {
          value: "labels",
          name:  p.muted("Issue labels".padEnd(W)) + val(pc.defaultLabels, p.purple),
        },
        {
          value: "baseBranch",
          name:  p.muted("Base branch".padEnd(W)) + val(pc.defaultBaseBranch ?? "develop"),
        },
        { value: "__done__", name: p.yellow("← Done") },
      ],
      theme: THEME,
    });
    console.log();
    if (field === "__done__") break;

    // ── Group path ──────────────────────────────────────────────────────────────
    if (field === "group") {
      const val = await input({
        message:  p.white("GitLab group path:"),
        default:  pc.group ?? autoGroup ?? "",
        theme:    THEME,
        validate: (v) => v.trim() !== "" || "Group path is required",
      });
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, group: val.trim() } });
      console.log();
    }

    // ── Epic filter label ───────────────────────────────────────────────────────
    if (field === "epicLabel") {
      const group = loadConfig().portal?.group;
      if (!group) { console.log("  " + p.yellow("Set group path first.\n")); continue; }

      process.stdout.write("  " + p.muted("Loading labels…\r"));
      let labelNames = [];
      try {
        const ls  = await glabApi(`groups/${encodeURIComponent(group)}/labels?per_page=100`);
        labelNames = Array.isArray(ls) ? ls.map((l) => l.name).sort() : [];
        process.stdout.write(" ".repeat(40) + "\r");
      } catch { process.stdout.write(" ".repeat(40) + "\r"); }

      let val;
      if (labelNames.length > 0) {
        val = await search({
          message: p.white("Epic filter label:"),
          source:  (v) => {
            const term = (v ?? "").toLowerCase().trim();
            return [
              { value: null, name: p.muted("— none —"), description: p.muted("assignee filter only") },
              ...labelNames
                .filter((l) => !term || l.toLowerCase().includes(term))
                .map((l) => ({
                  value:       l,
                  name:        p.purple(l),
                  description: l === pc.epicLabelFilter ? p.teal("current") : "",
                })),
            ];
          },
          theme: THEME,
        });
      } else {
        const raw = await input({
          message: p.white("Epic filter label") + p.muted(" (e.g. TECH::RHYTHM):"),
          default: pc.epicLabelFilter ?? "",
          theme:   { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
        });
        val = raw.trim() || null;
      }
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, epicLabelFilter: val } });
      console.log();
    }

    // ── Milestone ───────────────────────────────────────────────────────────────
    if (field === "milestone") {
      const group = loadConfig().portal?.group;
      if (!group) { console.log("  " + p.yellow("Set group path first.\n")); continue; }

      process.stdout.write("  " + p.muted("Loading milestones…\r"));
      let milestones = [];
      try {
        const ms   = await glabApi(`groups/${encodeURIComponent(group)}/milestones?state=active&per_page=50`);
        milestones = Array.isArray(ms) ? ms : [];
        process.stdout.write(" ".repeat(40) + "\r");
      } catch { process.stdout.write(" ".repeat(40) + "\r"); }

      if (milestones.length === 0) {
        console.log("  " + p.muted("No active milestones found.\n"));
        continue;
      }
      const val = await search({
        message: p.white("Default milestone:"),
        source:  (v) => {
          const term = (v ?? "").toLowerCase().trim();
          return [
            { value: null, name: p.muted("— none —"), description: p.muted("no default") },
            ...milestones
              .filter((m) => !term || m.title.toLowerCase().includes(term))
              .map((m) => ({
                value:       { id: m.id, title: m.title },
                name:        p.white(m.title),
                description: m.due_date ? p.muted("due " + m.due_date) : "",
              })),
          ];
        },
        theme: THEME,
      });
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, defaultMilestone: val } });
      console.log();
    }

    // ── Iteration ───────────────────────────────────────────────────────────────
    if (field === "iteration") {
      const group = loadConfig().portal?.group;
      if (!group) { console.log("  " + p.yellow("Set group path first.\n")); continue; }

      process.stdout.write("  " + p.muted("Loading iterations…\r"));
      let iterations = [];
      try {
        const it   = await glabApi(`groups/${encodeURIComponent(group)}/iterations?state=current&per_page=50`);
        iterations = Array.isArray(it) ? it : [];
        process.stdout.write(" ".repeat(40) + "\r");
      } catch { process.stdout.write(" ".repeat(40) + "\r"); }

      const val = await search({
        message: p.white("Default iteration:"),
        source:  (v) => {
          const term = (v ?? "").toLowerCase().trim();
          return [
            { value: null, name: p.muted("— none —"), description: p.muted("no default") },
            {
              value:       { id: ITER_CURRENT, title: "Current iteration" },
              name:        p.teal("★  Current iteration"),
              description: p.muted("always resolves to the active sprint"),
            },
            ...iterations
              .filter((it) => !term || iterLabel(it).toLowerCase().includes(term))
              .map((it) => {
                const label = iterLabel(it);
                return {
                  value:       { id: it.id, title: label },
                  name:        p.white(label),
                  description: it.start_date && it.due_date ? p.muted(`${it.start_date} → ${it.due_date}`) : "",
                };
              }),
          ];
        },
        theme: THEME,
      });
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, defaultIteration: val } });
      console.log();
    }

    // ── Default issue labels ────────────────────────────────────────────────────
    if (field === "labels") {
      const val = await input({
        message: p.white("Default issue labels") + p.muted(" (comma separated):"),
        default: pc.defaultLabels ?? "",
        theme:   { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
      });
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, defaultLabels: val.trim() } });
      console.log();
    }

    // ── Default base branch ─────────────────────────────────────────────────────
    if (field === "baseBranch") {
      const val = await input({
        message:  p.white("Default base branch:"),
        default:  pc.defaultBaseBranch ?? "develop",
        theme:    THEME,
        validate: (v) => v.trim() !== "" || "Cannot be empty",
      });
      saveConfig({ ...loadConfig(), portal: { ...loadConfig().portal, defaultBaseBranch: val.trim() } });
      console.log();
    }
  }

  return 0;
}

// ── Switch settings ────────────────────────────────────────────────────────────

async function cmdSwitchSettings(config) {
  const switchConfig = config.switch ?? {};
  const templates    = [...(switchConfig.branchSuggestions ?? [])];

  printSectionHeader("Switch Settings", "Branch suggestion templates");

  const showTemplates = () => {
    if (templates.length === 0) {
      console.log("  " + p.muted("No templates configured.\n"));
      return;
    }
    const now = new Date();
    console.log("  " + p.slate("Templates:"));
    templates.forEach((t, i) => {
      console.log(
        "  " + p.muted(`[${i + 1}]`) + " " + p.purple(t) +
        p.muted("  →  ") + p.white(expandBranchTemplate(t, now)),
      );
    });
    console.log();
  };

  showTemplates();

  while (true) {
    const action = await select({
      message: p.white("Branch suggestions:"),
      choices: [
        {
          value: "add",
          name:  p.cyan("+ Add template"),
          description: p.muted("e.g. sprint/{yyyy}-{mm}-W{w}  ·  tokens: {yyyy} {yy} {mm} {m} {dd} {d} {w} {ww} {q}"),
        },
        {
          value:    "remove",
          name:     p.red("✕ Remove template"),
          description: p.muted("pick one to delete"),
          disabled: templates.length === 0 ? "(none to remove)" : false,
        },
        { value: "done", name: p.green("✔ Save & close") },
      ],
      theme: THEME,
    });

    if (action === "done") break;

    if (action === "add") {
      const tpl = await input({
        message:  p.white("Template:"),
        theme:    THEME,
        validate: (v) => v.trim() !== "" || "Template cannot be empty",
      });
      const preview = expandBranchTemplate(tpl.trim());
      console.log("  " + p.muted("Preview today → ") + p.white(preview) + "\n");
      templates.push(tpl.trim());
      showTemplates();
    }

    if (action === "remove" && templates.length > 0) {
      const toRemove = await select({
        message: p.white("Remove:"),
        choices: templates.map((t) => ({
          value: t,
          name:  p.purple(t) + p.muted("  →  ") + p.white(expandBranchTemplate(t)),
        })),
        theme: THEME,
      });
      templates.splice(templates.indexOf(toRemove), 1);
      console.log("  " + p.muted("Removed ") + p.purple(toRemove) + "\n");
      showTemplates();
    }
  }

  saveConfig({ ...config, switch: { ...switchConfig, branchSuggestions: templates } });
  printSaved();
  return 0;
}

// ── MR settings ────────────────────────────────────────────────────────────────

async function cmdMrSettings(config) {
  printSectionHeader("Merge Request Settings", "Defaults applied when creating MRs");

  const W = 28;

  while (true) {
    const mr = loadConfig().mr ?? {};

    const field = await select({
      message: p.white("Edit:"),
      choices: [
        {
          value: "labels",
          name:  p.muted("Default labels".padEnd(W)) + (mr.labels ? p.purple(mr.labels) : p.dim("none")),
        },
        {
          value: "draft",
          name:  p.muted("Mark as draft by default".padEnd(W)) + (mr.isDraft ? p.yellow("yes") : p.muted("no")),
        },
        {
          value: "push",
          name:  p.muted("Push branch before MR".padEnd(W)) + (mr.pushFirst !== false ? p.green("yes") : p.muted("no")),
        },
        { value: "__done__", name: p.yellow("← Done") },
      ],
      theme: THEME,
    });
    console.log();
    if (field === "__done__") break;

    if (field === "labels") {
      const val = await input({
        message: p.white("Default labels") + p.muted(" (comma separated):"),
        default: mr.labels ?? "",
        theme:   { ...THEME, style: { ...THEME.style, answer: (s) => p.purple(s) } },
      });
      saveConfig({ ...loadConfig(), mr: { ...loadConfig().mr, labels: val.trim() } });
      console.log();
    }

    if (field === "draft") {
      const val = await confirm({
        message: p.white("Mark MRs as draft by default?"),
        default: mr.isDraft ?? false,
        theme:   THEME,
      });
      saveConfig({ ...loadConfig(), mr: { ...loadConfig().mr, isDraft: val } });
      console.log();
    }

    if (field === "push") {
      const val = await confirm({
        message: p.white("Push branch before creating MR by default?"),
        default: mr.pushFirst !== false,
        theme:   THEME,
      });
      saveConfig({ ...loadConfig(), mr: { ...loadConfig().mr, pushFirst: val } });
      console.log();
    }
  }

  return 0;
}

// ── Top-level settings command ─────────────────────────────────────────────────

export async function cmdSettings(repos) {
  console.log(
    boxen(
      chalk.bold(p.white("gsync Settings")) + "\n" +
      p.muted("Configure portal, switch & merge request defaults"),
      {
        padding:        { top: 0, bottom: 0, left: 2, right: 2 },
        borderStyle:    "round",
        borderColor:    "#334155",
        title:          p.muted(" settings "),
        titleAlignment: "right",
      },
    ),
  );
  console.log();

  while (true) {
    const config     = loadConfig();
    const portalCfg  = config.portal ?? {};
    const switchCfg  = config.switch ?? {};
    const mrCfg      = config.mr ?? {};

    const portalSummary = [
      portalCfg.group           && p.muted("group ") + p.cyan(portalCfg.group),
      portalCfg.epicLabelFilter && p.muted("label ") + p.purple(portalCfg.epicLabelFilter),
      portalCfg.defaultMilestone?.title && p.muted("milestone ") + p.teal(portalCfg.defaultMilestone.title),
      portalCfg.defaultIteration?.id   && p.muted("iteration ") + (
        portalCfg.defaultIteration.id === "__current__" ? p.teal("★ current") : p.cyan(portalCfg.defaultIteration.title ?? "set")
      ),
      portalCfg.defaultLabels   && p.muted("labels ") + p.purple(portalCfg.defaultLabels),
      portalCfg.defaultBaseBranch && p.muted("base ") + p.white(portalCfg.defaultBaseBranch),
    ].filter(Boolean).join(p.dim("  ·  "));

    const switchSummary = (switchCfg.branchSuggestions?.length ?? 0) > 0
      ? p.muted(switchCfg.branchSuggestions.length + " template(s)  ") +
        p.purple(switchCfg.branchSuggestions.slice(0, 2).join("  ") + (switchCfg.branchSuggestions.length > 2 ? "  …" : ""))
      : p.dim("no templates");

    const mrSummary = [
      mrCfg.labels    && p.muted("labels ") + p.purple(mrCfg.labels),
      mrCfg.isDraft   && p.yellow("draft"),
      mrCfg.pushFirst !== false && p.green("push first"),
    ].filter(Boolean).join(p.dim("  ·  ")) || p.dim("no defaults");

    const section = await select({
      message: p.white("Configure:"),
      choices: [
        {
          value: "portal",
          name:  chalk.hex("#FC6D26")("◈  Portal"),
          description: portalSummary || p.dim("not configured"),
        },
        {
          value: "switch",
          name:  p.purple("⇌  Switch"),
          description: switchSummary,
        },
        {
          value: "mr",
          name:  p.purple("⎇  Merge Requests"),
          description: mrSummary,
        },
        {
          value: "__done__",
          name:  p.yellow("← Done"),
        },
      ],
      theme: THEME,
    });

    console.log();
    if (section === "__done__") break;

    const freshConfig = loadConfig();
    const autoGroup   = detectGroupFromRepos(repos);

    if (section === "portal") await cmdPortalSettings(freshConfig, autoGroup);
    if (section === "switch") await cmdSwitchSettings(freshConfig);
    if (section === "mr")     await cmdMrSettings(freshConfig);
  }

  return 0;
}
