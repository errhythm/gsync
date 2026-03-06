import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

export const CONFIG_PATH = join(homedir(), ".config", "gsync", "gsync.json");

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (e) {
    process.stderr.write(`gsync: warning: could not save config: ${e.message}\n`);
  }
}
