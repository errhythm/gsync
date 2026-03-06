import { exec, execFile } from "child_process";
import { promisify } from "util";

export const execAsync     = promisify(exec);
export const execFileAsync = promisify(execFile);

export function extractMsg(e) {
  return (e.stderr || e.stdout || e.message || "")
    .toString()
    .replace(/\n/g, " ")
    .trim();
}
