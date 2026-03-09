import { cpus } from "os";
import { readFileSync } from "fs";

const pkgPath = new URL("../package.json", import.meta.url).pathname;
let VERSION = "1.6.0";
try {
  VERSION = JSON.parse(readFileSync(pkgPath, "utf8")).version;
} catch (e) {
  console.error("Failed to read version:", e);
}

export { VERSION };
export const MAX_JOBS = cpus().length;
export const DEFAULT_DEPTH = 4;
export const SUBCOMMANDS = new Set(["status", "fetch", "mr", "portal", "settings", "about"]);
