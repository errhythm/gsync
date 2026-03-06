import { execFileAsync, extractMsg } from "../utils/exec.js";

export async function glabApi(apiPath, { method = "GET", fields = {} } = {}) {
  const args = ["api", apiPath, "-X", method];
  for (const [k, v] of Object.entries(fields)) args.push("-F", `${k}=${v}`);
  try {
    const { stdout } = await execFileAsync("glab", args);
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(extractMsg(e));
  }
}

export async function glabGraphQL(query) {
  try {
    const { stdout } = await execFileAsync("glab", ["api", "graphql", "-f", `query=${query}`]);
    const result = JSON.parse(stdout);
    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join("; "));
    }
    return result.data;
  } catch (e) {
    throw new Error(extractMsg(e));
  }
}
