# Agent-only web tool design for Kyrei

## Goal
Add a **least-privilege, internal-only web capability** for agents so Kyrei can search and read the public web without turning the desktop app into a general-purpose browser.

## Constraints
- Keep Kyrei a **closed desktop app**. `electron/main.js` currently denies `window.open`, navigation, and redirects.
- Discovery only for this lane: **no product-code edits yet**.
- Network actions must stay **deny-by-default for local/private targets** and pass through Kyrei permission + audit controls.
- Do not add a user-facing browser tab, external navigation, or Electron `shell.openExternal`-style behavior.

## Evidence reviewed

### Kyrei today
- Shell boundary: `electron/main.js`
- Persisted runtime config: `core/gateway.js`
- Engine config/contracts: `core/engine/types.ts`, `core/engine/config/schema.ts`
- Permission engine + audit: `core/engine/security/permissions.ts`, `core/engine/security/audit.ts`, `core/engine/security/sandbox.ts`
- Tool runtime: `core/engine/tools/index.ts`, `core/engine/tools/tools.test.ts`
- Prompt/tool descriptions: `core/engine/prompt/system.ts`, `core/engine/prompt/tool-descriptions.ts`
- Existing HTML→text deps already shipped: `package.json`, `src/lib/katex-memo.ts`

### External references
- Electron docs: window creation control via `webContents.setWindowOpenHandler()` and process model / utility process
- OWASP SSRF Prevention Cheat Sheet
- Node docs: `fetch`, `URL`, `dns.lookup()`, `net.BlockList`
- Playwright license/docs for the optional later JS-rendered slice only

## Recommendation summary

**Do not start with an embedded Chromium/browser-view tool.**

The safest first implementation is a **fetch-first, text-extraction-first web tool**:

1. `web_fetch` — fetch one public `http/https` URL, re-validate every redirect, extract readable text, return metadata.
2. `web_search` — optional second slice behind a pluggable search adapter; do **not** scrape arbitrary search-result HTML as the primary design.
3. `web_render` / scripted navigation — optional later slice only, isolated in an Electron utility process if Kyrei later needs JS-heavy sites.

This respects Kyrei's current product boundary, reuses existing dependencies, and keeps SSRF risk materially lower than a hidden browser session.

## Option assessment

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Node `fetch` + HTML-to-text extraction** | No new browser UI, no new heavy dependency, fits current tool model, easiest to audit, easiest to deny private/local targets | No JS execution; some modern sites will degrade | **Start here** |
| **B. Hidden `BrowserWindow` / `webContents` / `BrowserView`** | Full Chromium behavior, easier SPA rendering | Reintroduces navigation/cookie/session/browser semantics Kyrei currently blocks; harder SSRF and permission story | **Reject as first slice** |
| **C. Playwright/headless Chromium in utility process** | Better JS-site compatibility, process isolation possible | Heavy packaging/runtime cost, browser download/bundle concerns, bigger attack surface | **Later, optional** |

## Why Option A fits Kyrei best

1. `core/engine/tools/index.ts` already models small, synchronous-style tools returning text.
2. Kyrei already ships HTML parsing helpers (`hast-util-from-html-isomorphic`, `hast-util-to-text`) and uses them in `src/lib/katex-memo.ts`.
3. `core/engine/security/permissions.ts` and `audit.ts` already provide the right insertion points for network gating and append-only logging.
4. `electron/main.js` explicitly enforces the closed-desktop boundary; a fetch-first tool preserves that boundary instead of bypassing it.

## Proposed staged design

### Slice A — public-web fetch + extract (recommended first implementation slice)

#### Tool surface
- `web_fetch({ url, maxChars? })`
  - accepts only `http:` and `https:`
  - refuses embedded credentials, fragments as control inputs, non-default dangerous ports if policy forbids them
  - follows at most `N` redirects with **manual redirect handling**
  - returns extracted text plus metadata: `{ finalUrl, status, contentType, title, truncated, bytes }`

#### Implementation shape
Create a dedicated helper module instead of bloating `tools/index.ts`:
- new `core/engine/tools/web-client.ts`
- new `core/engine/tools/web-policy.ts`
- wire tool definition from `core/engine/tools/index.ts`

Suggested flow:
1. Parse with `new URL()`.
2. Normalize hostname/origin.
3. Reject unsupported protocols and any username/password.
4. Resolve hostname before request.
5. Deny loopback/private/link-local/ULA/reserved addresses.
6. `fetch(..., { redirect: "manual" })` with timeout + byte cap.
7. On `Location`, re-run the full validator before the next hop.
8. Accept only text-like content (`text/html`, `text/plain`, maybe `application/xhtml+xml` for the first slice).
9. Convert HTML to text with existing HAST utilities.
10. Clip output to `maxChars` / engine cap.

#### Exact Kyrei touchpoints
- `core/engine/types.ts`
  - add `web` config + permission types
- `core/engine/config/schema.ts`
  - validate defaults / migrations / fail-open handling for new web config
- `core/engine/security/permissions.ts`
  - add decisions for `web_fetch` / later `web_search`
- `core/engine/security/audit.ts`
  - log normalized URL, final URL, decision, redirect count, content type, byte count, blocked reason
- `core/engine/tools/index.ts`
  - register `web_fetch`
- `core/engine/prompt/tool-descriptions.ts`
  - describe the tool as public-web, read-only, no-auth
- `core/engine/prompt/system.ts`
  - add a short rule: use web tools only for public information; never send secrets; never probe local/private hosts
- `core/gateway.js`
  - persist and echo non-secret `engine.web` settings

### Slice B — pluggable search adapter

#### Why a separate slice
Search has different product/legal tradeoffs than simple URL fetching. Shipping a hard-coded search-site scraper is brittle and may create ToS risk.

#### Recommended design
Add a small adapter contract instead of coupling the engine to one vendor:

```ts
interface WebSearchProviderConfig {
  kind: "generic-json" | "brave";
  baseURL: string;
  apiKeyEnv?: string;
  queryParam?: string;
  resultPath?: string;
}
```

Tool surface:
- `web_search({ query, maxResults? })`
  - returns normalized result rows: `[{ title, url, snippet }]`
  - tool remains read-only; it never auto-fetches result pages without an explicit `web_fetch`

Exact files:
- new `core/engine/tools/web-search.ts`
- `core/engine/types.ts`
- `core/engine/config/schema.ts`
- `core/gateway.js`
- `core/engine/tools/index.ts`

### Slice C — optional JS-rendered browsing in an isolated utility process

Use this only if Slice A/B prove insufficient for high-value sites.

#### Recommended boundary
- Spawn from Electron main using a **utility process**, not a renderer-visible browser surface.
- Keep cookies/storage ephemeral and process-local.
- Disable downloads, file access, permission prompts, uploads, and external window creation.
- Expose only a narrow IPC contract back to the gateway: `render(url) -> { title, text, links, screenshot? }`.

Exact future touchpoints:
- `electron/main.js`
- new `electron/web-tool-process.(js|ts)` or `core/web/utility-process/*`
- `core/gateway.js` bridge for request/response
- engine tool modules stay thin wrappers

## Proposed config / type shape

```ts
interface WebPermissionConfig {
  mode: "off" | "search" | "read";
}

interface WebToolConfig {
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  maxExtractChars: number;
  allowPrivateHosts: boolean;
  allowedDomains: string[];
  blockedCidrs: string[];
  renderJs: "off" | "utility-process";
  searchProvider?: WebSearchProviderConfig;
}
```

Recommended placement:
- `PermissionConfig.web: WebPermissionConfig`
- `EngineConfig.web: WebToolConfig`

Rationale:
- permission answers **whether** the tool may run
- web config answers **how** it may run

## Permission model

Extend the existing two-axis system instead of inventing a parallel approval framework.

### Default policy
- `permissions.web.mode = "off"`
- enabling web access is explicit
- private/local targets remain blocked even when web mode is enabled unless `allowPrivateHosts` is explicitly true

### Decision rules
- `web_search`
  - allow only when `mode` is `search` or `read`
- `web_fetch`
  - allow only when `mode` is `read`
- any target matching deny-rules or blocked CIDRs
  - **deny wins**
- if target is external and review mode is `always`
  - may emit `approval.request` for first-run or policy-sensitive cases

Suggested `permissions.ts` additions:
- tool category recognition for `web_search` / `web_fetch`
- explicit `destructive: false` but `network: true`
- deny-by-default for local/private targets regardless of user prompt content

## SSRF defense plan

This is the critical design requirement.

### Required controls
1. **Protocol allowlist**: only `http:` and `https:`.
2. **No credentials in URLs**: reject `user:pass@host`.
3. **Hostname resolution before connect**: resolve every hop.
4. **IP classification denylist**: block at least:
   - `127.0.0.0/8`
   - `10.0.0.0/8`
   - `172.16.0.0/12`
   - `192.168.0.0/16`
   - `169.254.0.0/16`
   - `::1/128`
   - `fc00::/7`
   - `fe80::/10`
   - wildcard/unspecified/broadcast/reserved ranges
5. **Redirect re-validation**: never let the HTTP client auto-follow blindly.
6. **No cookies / no ambient auth**: do not attach browser session state.
7. **Timeout + byte caps**: stop slow or giant responses.
8. **Content-type allowlist**: first slice is text only.
9. **Audit every deny** with normalized reason.
10. **No `file:`, `data:`, `blob:`, `javascript:`, `ws:`, `wss:`**.

### DNS / rebinding note
A pure preflight `dns.lookup()` check is necessary but not sufficient against rebinding if the actual connection resolves differently later. For Slice A, Kyrei should:
- resolve each redirect hop before fetch
- prefer direct-IP connect patterns only in a later hardened slice if needed
- document residual risk honestly instead of pretending complete SSRF elimination

## Audit requirements

Extend `createAuditLog()` records for web tools with:
- `tool`
- normalized input URL
- final URL
- decision (`allow` / `deny` / `ask`)
- resolved addresses (redacted if policy requires)
- redirect count
- status code
- content type
- byte count
- duration
- blocked reason / error

Do **not** log full page bodies by default. Log metadata only.

## Test plan

### Unit tests
Add focused tests in new or existing files:
- `core/engine/tools/web.test.ts`
  - rejects `file://`, `data:`, `javascript:`
  - rejects `http://127.0.0.1/`
  - rejects hostname resolving to private IP
  - rejects credentialed URLs
  - re-validates redirects
  - clips oversized body/output
  - extracts visible text from HTML
- `core/engine/security/security.test.ts`
  - permission decisions for `web_search` / `web_fetch`
- `core/engine/config/config.test.ts`
  - defaults and fail-open handling for `permissions.web` and `engine.web`

### Integration tests
- local HTTP server returning HTML, text, redirect chains, and large bodies
- local DNS/address classification fixtures where feasible
- audit log assertions for allow + deny paths

### Manual / end-to-end checks
1. Enable `permissions.web.mode = "read"`.
2. Ask the agent to summarize `https://example.com`.
3. Confirm `tool.start` / `tool.complete` events appear and output is clipped/sanitized.
4. Confirm an audit record is written.
5. Ask the agent to fetch `http://127.0.0.1/`.
6. Confirm a hard deny with a clear reason and no network body leakage.

## Dependency and licensing notes

### Safe first slice
No new dependency is required for Slice A.
- existing `hast-util-from-html-isomorphic` — MIT
- existing `hast-util-to-text` — MIT
- built-in Node `fetch`, `URL`, `dns`, `net`

### Optional later slice
- Playwright is acceptable **only as an optional later dependency**; its current upstream repository is Apache-2.0, but it increases package/runtime complexity and should not gate the first ship.

## Recommended implementation order

1. **Slice A** — `web_fetch` with strict SSRF policy and audit
2. **Slice B** — `web_search` adapter contract, disabled by default until configured
3. **Slice C** — optional JS-rendered utility-process browser for specific sites

## Bottom line

Kyrei should add the web as a **read-only network tool**, not as a hidden browser surface.

The smallest safe slice is:
- no UI browser
- no renderer navigation
- no ambient cookies
- no local/private network reachability
- existing HTML-to-text deps only
- full audit trail

That gets Kyrei public-web reading ability quickly while preserving the desktop boundary already enforced in `electron/main.js`.

## Reference links
- Electron window creation control: https://www.electronjs.org/docs/latest/api/window-open
- Electron process model / utility process: https://www.electronjs.org/docs/latest/tutorial/process-model
- OWASP SSRF cheat sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- Node `fetch`: https://nodejs.org/api/globals.html#fetch
- Node `dns.lookup()`: https://nodejs.org/api/dns.html#dnslookuphostname-options-callback
- Node `URL`: https://nodejs.org/api/url.html
- Node `net.BlockList`: https://nodejs.org/api/net.html#class-netblocklist
- Playwright license: https://github.com/microsoft/playwright/blob/main/LICENSE
