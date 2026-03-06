import chalk from "chalk";

export const p = {
  cyan:   chalk.hex("#67e8f9"),
  teal:   chalk.hex("#4ecdc4"),
  purple: chalk.hex("#c084fc"),
  green:  chalk.hex("#4ade80"),
  yellow: chalk.hex("#fbbf24"),
  red:    chalk.hex("#f87171"),
  orange: chalk.hex("#fb923c"),
  muted:  chalk.hex("#64748b"),
  slate:  chalk.hex("#475569"),
  dim:    chalk.hex("#1e293b"),
  white:  chalk.hex("#f1f5f9"),
  bold:   chalk.bold,
};

export const THEME = {
  prefix: p.purple("◆"),
  icon:   { cursor: " " },
  style: {
    highlight:     (s) => chalk.bgHex("#5b21b6").white.bold(s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")),
    answer:        (s) => p.cyan(s),
    defaultAnswer: (s) => p.muted(s),
  },
};
