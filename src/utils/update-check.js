/**
 * Non-blocking npm update checker.
 *
 * - Checks the npm registry for a newer version of the package.
 * - Throttled to at most once per day using a cache entry in the gitmux config.
 * - Run checkForUpdate() early (don't await) to fetch in the background, then
 *   call awaitUpdateCheck() before blocking on user input to show the notice.
 */

import { createRequire } from "module";
import { loadConfig, saveConfig } from "../config/index.js";

const require = createRequire(import.meta.url);

// Read own package.json without dynamic import (avoids assertion syntax issues)
let PKG_NAME = "@errhythm/gitmux";
let PKG_VERSION = "0.0.0";
try {
    // Walk up from this file: src/utils/ → src/ → root
    const pkg = require("../../package.json");
    PKG_NAME = pkg.name;
    PKG_VERSION = pkg.version;
} catch { /* ignore */ }

/** ms in one day */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Registry URL — use the unscoped form to avoid encoding issues */
function registryUrl(name) {
    return `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`;
}

// Internal promise handle — resolved by checkForUpdate()
let _resolve;
let _updatePromise = new Promise((r) => { _resolve = r; });

/**
 * Kick off the update check in the background.
 * Call this EARLY in startup (do NOT await).
 */
export function checkForUpdate() {
    (async () => {
        try {
            const cfg = loadConfig();
            const cache = cfg._updateCheck ?? {};
            const now = Date.now();

            // Only hit the network once per day
            if (cache.lastChecked && (now - cache.lastChecked) < ONE_DAY_MS) {
                _resolve({ latest: cache.latest ?? null, current: PKG_VERSION });
                return;
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);

            let latest = null;
            try {
                const res = await fetch(registryUrl(PKG_NAME), { signal: controller.signal });
                const data = await res.json();
                latest = data["dist-tags"]?.latest ?? null;
            } catch {
                // Network error / timeout — silently skip
            } finally {
                clearTimeout(timeout);
            }

            // Persist the result so we don't hammer npm
            if (latest) {
                saveConfig({
                    ...loadConfig(),
                    _updateCheck: { lastChecked: now, latest },
                });
            }

            _resolve({ latest, current: PKG_VERSION });
        } catch {
            _resolve({ latest: null, current: PKG_VERSION });
        }
    })();
}

/**
 * Await the background check and return a boxen-ready notice string,
 * or null if the user is already on the latest version.
 */
export async function awaitUpdateCheck() {
    const { latest, current } = await _updatePromise;
    if (!latest) return null;

    // Simple semver comparison (major.minor.patch — no pre-release needed)
    if (!isNewer(latest, current)) return null;

    return { latest, current };
}

/** Returns true if `candidate` is strictly newer than `baseline`. */
function isNewer(candidate, baseline) {
    const toNum = (v) => v.split(".").map(Number);
    const [ma, mi, pa] = toNum(candidate);
    const [mb, mib, pb] = toNum(baseline);
    if (ma !== mb) return ma > mb;
    if (mi !== mib) return mi > mib;
    return pa > pb;
}
