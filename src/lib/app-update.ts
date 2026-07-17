/**
 * Manual update check against GitHub Releases (no auto-download / install).
 * Renderer-only fetch; opening the release page goes through desktop IPC allowlist.
 */

export const KYREI_GITHUB_OWNER = "dizzzable";
export const KYREI_GITHUB_REPO = "Kyrei";
export const KYREI_RELEASES_PAGE_URL = `https://github.com/${KYREI_GITHUB_OWNER}/${KYREI_GITHUB_REPO}/releases`;
export const KYREI_LATEST_RELEASE_API =
  `https://api.github.com/repos/${KYREI_GITHUB_OWNER}/${KYREI_GITHUB_REPO}/releases/latest`;

export type UpdateCheckResult =
  | {
    status: "up_to_date";
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
  }
  | {
    status: "available";
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    releaseName?: string;
  }
  | {
    status: "error";
    currentVersion: string;
    error: string;
  };

/** Strip leading `v` / whitespace; keep major.minor.patch (+ optional pre). */
export function normalizeVersion(raw: string): string {
  const text = String(raw ?? "").trim().replace(/^v/i, "");
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) return "";
  const major = match[1] ?? "0";
  const minor = match[2] ?? "0";
  const patch = match[3] ?? "0";
  return `${major}.${minor}.${patch}`;
}

/**
 * Compare two normalized or raw versions.
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareSemver(a: string, b: string): number {
  const left = normalizeVersion(a).split(".").map((part) => Number(part) || 0);
  const right = normalizeVersion(b).split(".").map((part) => Number(part) || 0);
  while (left.length < 3) left.push(0);
  while (right.length < 3) right.push(0);
  for (let i = 0; i < 3; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function isAllowedUpdateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "github.com") return false;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const prefix = `/${KYREI_GITHUB_OWNER}/${KYREI_GITHUB_REPO}/releases`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function releaseTagUrl(tagName: string): string {
  const tag = String(tagName ?? "").trim().replace(/^v/i, "");
  return `${KYREI_RELEASES_PAGE_URL}/tag/v${tag || "0.0.0"}`;
}

interface GitHubReleaseJson {
  tag_name?: unknown;
  html_url?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export function parseLatestReleasePayload(
  payload: unknown,
  currentVersion: string,
): UpdateCheckResult {
  const current = normalizeVersion(currentVersion) || "0.0.0";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: "error", currentVersion: current, error: "invalid_release_payload" };
  }
  const data = payload as GitHubReleaseJson;
  if (data.draft === true) {
    return { status: "error", currentVersion: current, error: "latest_is_draft" };
  }
  const tagName = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
  const latest = normalizeVersion(tagName);
  if (!latest) {
    return { status: "error", currentVersion: current, error: "missing_tag" };
  }
  const htmlUrl = typeof data.html_url === "string" && data.html_url.trim()
    ? data.html_url.trim()
    : releaseTagUrl(tagName);
  if (!isAllowedUpdateUrl(htmlUrl)) {
    return { status: "error", currentVersion: current, error: "release_url_not_allowed" };
  }
  const releaseName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
  const cmp = compareSemver(current, latest);
  if (cmp >= 0) {
    return {
      status: "up_to_date",
      currentVersion: current,
      latestVersion: latest,
      releaseUrl: htmlUrl,
    };
  }
  return {
    status: "available",
    currentVersion: current,
    latestVersion: latest,
    releaseUrl: htmlUrl,
    ...(releaseName ? { releaseName } : {}),
  };
}

export async function checkForAppUpdate(options?: {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<UpdateCheckResult> {
  const currentVersion = normalizeVersion(options?.currentVersion ?? (
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0"
  )) || "0.0.0";
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { status: "error", currentVersion, error: "fetch_unavailable" };
  }
  try {
    const response = await fetchImpl(KYREI_LATEST_RELEASE_API, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Kyrei/${currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: options?.signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        currentVersion,
        error: `http_${response.status}`,
      };
    }
    const payload: unknown = await response.json();
    return parseLatestReleasePayload(payload, currentVersion);
  } catch (error) {
    const message = error instanceof Error ? error.message : "network_error";
    if (message.includes("abort") || (error as { name?: string })?.name === "AbortError") {
      return { status: "error", currentVersion, error: "aborted" };
    }
    return { status: "error", currentVersion, error: "network_error" };
  }
}
