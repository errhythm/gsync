import chalk from "chalk";
import { p } from "./theme.js";

// Convert HSL (h: 0-360, s: 0-100, l: 0-100) to a hex colour string
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

// Deterministically map a prefix string to a hue (0–359)
function prefixHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Colour a GitLab label by hashing its namespace prefix (e.g. "STA", "PRI", "TECH")
// Works for any prefix — same prefix always gets the same colour.
export function colorLabel(label) {
  const prefix = label.split("::")[0].trim();
  const hex = hslToHex(prefixHue(prefix.toUpperCase()), 65, 72);
  return chalk.hex(hex)(label);
}

export function colorBranch(name) {
  const n = name.trimEnd();
  const pad = name.slice(n.length);
  const color =
    n === "main" || n === "master"
      ? p.red
      : /^(feature|feat)/.test(n)
        ? p.cyan
        : /^(hotfix|fix|bugfix)/.test(n)
          ? p.orange
          : /^(release|rel)/.test(n)
            ? p.teal
            : /^(develop|dev)$/.test(n)
              ? p.purple
              : /^sprint/.test(n)
                ? p.yellow
                : /^(chore|refactor|docs|test)/.test(n)
                  ? p.muted
                  : p.white;
  return color(n) + pad;
}
