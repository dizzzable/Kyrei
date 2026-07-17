/**
 * Allow Kyrei GitHub release pages/downloads through shell.openExternal,
 * plus a tight experimental OAuth verification allowlist (device-flow only).
 * Shared with renderer allowlist logic in src/lib/app-update.ts (same release rules).
 */

import { isAllowedExperimentalAuthOpenUrl } from "../core/browser-subscription-device-flow.js";

const OWNER = "dizzzable";
const REPO = "Kyrei";

/**
 * @param {string} url
 * @param {{ sessionVerificationUri?: string }} [options]
 * @returns {boolean}
 */
export function isAllowedDesktopExternalUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "github.com") {
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const prefix = `/${OWNER}/${REPO}/releases`;
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  // Experimental device verification: known hosts OR exact URI from an active session.
  return isAllowedExperimentalAuthOpenUrl(url, {
    sessionVerificationUri: options.sessionVerificationUri,
  });
}

/**
 * @param {{ openExternal: (url: string) => Promise<void> | void }} shell
 * @param {string} url
 * @param {{ sessionVerificationUri?: string }} [options]
 */
export async function openDesktopExternalUrl(shell, url, options = {}) {
  if (!shell || typeof shell.openExternal !== "function") {
    throw new Error("desktop_shell_unavailable");
  }
  if (!isAllowedDesktopExternalUrl(url, options)) {
    throw new Error("external_url_not_allowed");
  }
  await shell.openExternal(url);
}
