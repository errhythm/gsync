import { execFileAsync, extractMsg } from "../utils/exec.js";

const DEBUG = () => process.env.GITMUX_DEBUG === "1";

function dbg(label, value) {
  if (!DEBUG()) return;
  process.stderr.write(
    `\n\x1b[35m[gitmux:debug] ${label}\x1b[0m\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }\n`,
  );
}

export async function glabApi(apiPath, { method = "GET", fields = {} } = {}) {
  const args = ["api", apiPath, "-X", method];
  for (const [k, v] of Object.entries(fields)) args.push("-F", `${k}=${v}`);
  dbg("glab " + args.join(" "), "");
  try {
    const { stdout } = await execFileAsync("glab", args);
    const parsed = JSON.parse(stdout);
    dbg("response", parsed);
    return parsed;
  } catch (e) {
    dbg("ERROR stdout", e.stdout ?? "");
    dbg("ERROR stderr", e.stderr ?? "");
    dbg("ERROR message", e.message ?? "");
    throw new Error(extractMsg(e));
  }
}

export async function glabGraphQL(query) {
  dbg("graphql query", query);
  try {
    const { stdout } = await execFileAsync("glab", ["api", "graphql", "-f", `query=${query}`]);
    const result = JSON.parse(stdout);
    dbg("graphql response", result);
    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join("; "));
    }
    return result.data;
  } catch (e) {
    dbg("ERROR stdout", e.stdout ?? "");
    dbg("ERROR stderr", e.stderr ?? "");
    dbg("ERROR message", e.message ?? "");
    throw new Error(extractMsg(e));
  }
}
