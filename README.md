# gitmux 🔄

Multi-repo Git & GitLab workflow CLI — switch branches, manage epics & issues, create MRs, all from the terminal.

```
 ██████╗ ██╗████████╗███╗   ███╗██╗   ██╗██╗  ██╗
██╔════╝ ██║╚══██╔══╝████╗ ████║██║   ██║╚██╗██╔╝
██║  ███╗██║   ██║   ██╔████╔██║██║   ██║ ╚███╔╝
██║   ██║██║   ██║   ██║╚██╔╝██║██║   ██║ ██╔██╗
╚██████╔╝██║   ██║   ██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗
 ╚═════╝ ╚═╝   ╚═╝   ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

`gitmux` finds every `.git` repository up to 4 levels deep from your current folder and lets you act on all of them at once — branch switching, status checks, fetch, GitLab merge requests, and a full GitLab development portal (epics, issues, branches) — all from a single interactive TUI.

Made by E.R.Rhythm.

## Features

- **Blazing Fast** — Parallel workers (up to CPU count) for all git operations.
- **Live UI** — Real-time spinners showing `main → develop` transitions per repo.
- **`gitmux switch`** — Switch branches across all repos simultaneously with pull, stash, create, fuzzy match, and dry-run support.
- **`gitmux status`** — Table view of all repos: current branch, dirty file count, ahead/behind remote.
- **`gitmux fetch`** — Fetch all remotes across repos in parallel.
- **`gitmux mr`** — Interactively create GitLab merge requests via `glab` CLI for one or multiple repos at once.
- **`gitmux portal`** — GitLab Development Portal: browse assigned Epics, view & create Issues per project, create branches, and checkout primary branches across repos.
- **`gitmux settings`** — Configure branch suggestion templates, MR defaults, and portal defaults interactively.
- **Branch suggestions** — Configure interactive switch presets like `sprint/{yyyy}-{mm}-W{w}` in settings.
- **Auto-stash** — Stash dirty repos before switching, pop after (`--stash`).
- **Create branch** — Create the branch if it doesn't exist (`--create`).
- **Fuzzy matching** — Partial branch name resolution with interactive picker for ambiguous matches.
- **Dry-run mode** — Preview what would happen without touching anything (`--dry-run`).
- **Smart skipping** — Repos without the target branch are skipped cleanly.
- **Exclude / filter** — Skip or include repos matching a name pattern.
- **Color-coded branches** — `main/master` red, `feature/` cyan, `hotfix/` orange, `develop/` purple.
- **Scriptable** — Pass flags directly for use in CI/bash pipelines.

## Installation

```bash
npm install -g @errhythm/gitmux
```

*(Requires Node.js 22.13+)*

Both `gitmux` and the shorter alias `gmux` are available after install.

## Usage

### Interactive mode

```bash
gitmux
```

Launches a mode selector: **Switch branches** or **GitLab** (portal + MRs).

If configured, interactive switch mode first shows computed branch suggestions from `~/.config/gitmux/gitmux.json`, then offers `Custom branch...` if you want to type something else.

### Switch branches

```bash
gitmux develop
gitmux main --pull
gitmux feature/auth --stash --pull
gitmux feat --fuzzy
gitmux experiment --create
```

### Show repo status

```bash
gitmux status
```

Displays a table of every repo with its current branch, dirty file count, and ahead/behind remote sync status.

### Fetch all remotes

```bash
gitmux fetch
```

Runs `git fetch --all --prune` across all repos in parallel and shows ahead/behind per repo.

### Create merge requests (GitLab)

```bash
gitmux mr
```

Requires [`glab`](https://gitlab.com/gitlab-org/cli#installation) to be installed and authenticated.

Shows all repos with their current branch. Select one or more repos, fill in the details once (title, description, target branch, labels, draft, push first). `gitmux` builds the `glab mr create` command for each repo and runs them, printing each MR URL on completion.

Last-used MR settings (target branch, labels, draft mode, push preference, scope) are remembered between runs.

### GitLab Development Portal

```bash
gitmux portal
gitmux portal --settings
```

Requires [`glab`](https://gitlab.com/gitlab-org/cli#installation) installed and authenticated.

Opens an interactive TUI that:

1. **Auto-detects your GitLab group** from local repo remote URLs (saved to config on first run).
2. **Shows Epics assigned to you** — searchable list from the GitLab API.
3. **Browse issues** under each epic — view branches, set a primary branch per issue.
4. **Checkout primary branches** — switch all matching local repos to their primary branches in one step.
5. **Create an Issue** — default title is `Epic Name - Project Name`, pre-fills configured milestone, iteration, and labels.
6. **Create a Branch** — immediately after issue creation, with a default name of `feature/{iid}-{slug}` cut from the configured base branch.

Run with `--settings` to configure portal defaults (see Settings below).

### Settings

```bash
gitmux settings
```

Opens an interactive settings menu with three sections:

| Section | What you can configure |
|---------|----------------------|
| **Portal** | GitLab group path, epic filter label, default milestone, default iteration, default issue labels, base branch |
| **Switch** | Branch suggestion templates (with date tokens) |
| **Merge Requests** | Default labels, draft mode, push-before-MR |

### Dry-run

```bash
gitmux --dry-run develop
```

Preview what would happen without making any changes.

## All flags

| Flag | Short | Description |
|------|-------|-------------|
| `--pull` | `-p` | Pull latest on the target branch after switching |
| `--fuzzy` | `-f` | Partial branch name matching |
| `--create` | `-c` | Create the branch if it doesn't exist |
| `--stash` | `-s` | Auto-stash dirty repos before switching, pop after |
| `--fetch` | | Fetch all remotes before switching |
| `--dry-run` | | Preview actions without executing |
| `--depth n` | | Repo search depth (default: `4`) |
| `--exclude p` | | Exclude repos whose name contains pattern `p` |
| `--filter p` | | Only include repos whose name contains pattern `p` |
| `--settings` | | Open portal settings (use with `gitmux portal`) |
| `--version` | `-v` | Show version number |
| `--help` | `-h` | Show help |

## Requirements for `gitmux mr` and `gitmux portal`

- [`glab`](https://gitlab.com/gitlab-org/cli#installation) installed and on `$PATH`
- `glab auth login` completed for your GitLab instance

## Configuration

`gitmux` reads optional settings from `~/.config/gitmux/gitmux.json`.

Example:

```json
{
  "switch": {
    "branchSuggestions": [
      "sprint/{yyyy}-{mm}-W{w}",
      "release/{yyyy}-{mm}",
      "hotfix/{yyyy}-{mm}-{dd}",
      "main"
    ]
  },
  "mr": {
    "scope": "multi",
    "targetBranch": "develop",
    "labels": "backend,sprint",
    "isDraft": false,
    "pushFirst": true
  },
  "portal": {
    "group": "company/subgroup",
    "epicLabelFilter": "TECH::BACKEND",
    "defaultMilestone": { "id": 42, "title": "Sprint 5" },
    "defaultIteration": { "id": "__current__", "title": "Current iteration" },
    "defaultLabels": "backend",
    "defaultBaseBranch": "develop"
  }
}
```

### Switch template tokens

| Token | Description | Example |
|-------|-------------|---------|
| `{yyyy}` | 4-digit year | `2026` |
| `{yy}` | 2-digit year | `26` |
| `{mm}` | Zero-padded month | `03` |
| `{m}` | Month | `3` |
| `{dd}` | Zero-padded day | `07` |
| `{d}` | Day | `7` |
| `{q}` | Quarter | `1` |
| `{w}` | Week of month | `1` |
| `{ww}` | ISO week of year | `09` |

## How it works

1. Searches for `.git` folders from the current directory up to `--depth` levels deep.
2. Applies any `--exclude` / `--filter`, then prints a session info box.
3. In fuzzy mode, resolves partial branch names per repo (interactive picker for ambiguity).
4. Runs all git operations concurrently using parallel workers.
5. Each task shows live `current → target` branch transitions with timing.
6. Prints a clean summary: done / pulled / stashed / skipped / failed.

---

**License**: MIT
