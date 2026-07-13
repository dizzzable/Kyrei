# Provider Catalog and Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Hermes-grade provider setup and truthful model selection in Kyrei, including predefined templates, unlimited custom profiles, secure upstream model discovery, session-scoped composer selection, and a real model assignment for read-only subagents.

**Architecture:** Provider metadata remains in the versioned gateway registry while credentials remain in the OS-protected secret store. A bounded discovery adapter queries provider model endpoints without persisting draft credentials. Default provider/model settings are distinct from session provider/model overrides, and the engine receives a gateway-resolved private worker target so auxiliary selection never exposes credentials to the renderer.

**Tech Stack:** Electron 43, React 19, TypeScript, Node HTTP gateway, AI SDK 7, Vitest, Playwright Electron automation, EN/RU catalogue localization.

---

### Task 1: Lock provider and session contracts with failing tests

**Files:**
- Modify: `tests/provider-config.test.ts`
- Modify: `tests/gateway-provider.test.ts`
- Modify: `tests/gateway-capabilities.test.ts`
- Modify: `core/engine/orchestrator/run.test.ts`

- [ ] **Step 1: Add provider ID, assignment, and session override regressions**

```ts
expect(created.providers.at(-1)).toMatchObject({ id: "xpiki", name: "Xpiki" });
expect(renamed.providers.find((item) => item.id === "xpiki")?.name).toBe("Xpiki Cloud");
expect(config.modelAssignments.worker).toEqual({ providerId: "xpiki", modelId: "worker-model" });
expect(session).toMatchObject({ providerId: "xpiki", modelId: "chat-model" });
```

- [ ] **Step 2: Add tests proving composer selection does not mutate defaults**

```ts
expect(afterSessionPatch.activeProviderId).toBe(defaultProviderId);
expect(afterSessionPatch.activeModelId).toBe(defaultModelId);
expect(afterSessionPatch.sessions[0]).toMatchObject({ providerId: "xpiki", modelId: "chat-model" });
```

- [ ] **Step 3: Add worker routing safety tests**

```ts
expect(buildModelMock).toHaveBeenCalledWith(expect.objectContaining({
  baseURL: "https://worker.example/v1",
  apiKey: "worker-secret",
  model: "worker-model",
}));
expect(buildProviderOptionsMock).toHaveBeenCalledWith("openai-chat", undefined);
```

- [ ] **Step 4: Run the focused tests and verify they fail for missing contracts**

Run: `npx vitest --run tests/provider-config.test.ts tests/gateway-provider.test.ts core/engine/orchestrator/run.test.ts`

Expected: failures mention `modelAssignments`, session model patching, explicit provider IDs, and distinct worker model construction.

### Task 2: Add curated provider templates and strict public provider validation

**Files:**
- Create: `core/provider-templates.js`
- Create: `tests/provider-templates.test.ts`
- Modify: `core/provider-config.js`
- Modify: `tests/provider-config.test.ts`

- [ ] **Step 1: Define secret-free provider templates**

```js
export const PROVIDER_TEMPLATES = Object.freeze([
  { id: "openai", name: "OpenAI", protocol: "openai-responses", baseURL: "https://api.openai.com/v1", requiresApiKey: true },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseURL: "https://api.anthropic.com/v1", requiresApiKey: true },
  { id: "gemini", name: "Google Gemini", protocol: "google-generative-ai", baseURL: "https://generativelanguage.googleapis.com/v1beta", requiresApiKey: true },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-chat", baseURL: "https://openrouter.ai/api/v1", requiresApiKey: true },
  { id: "deepseek", name: "DeepSeek", protocol: "openai-chat", baseURL: "https://api.deepseek.com", requiresApiKey: true },
  { id: "xai", name: "xAI", protocol: "openai-chat", baseURL: "https://api.x.ai/v1", requiresApiKey: true },
  { id: "ollama", name: "Ollama", protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", requiresApiKey: false },
  { id: "lm-studio", name: "LM Studio", protocol: "openai-chat", baseURL: "http://127.0.0.1:1234/v1", requiresApiKey: false },
  { id: "custom", name: "Custom provider", custom: true },
]);
```

- [ ] **Step 2: Add strict mutation validation while preserving tolerant migration normalization**

```js
export function validateProviderInput(input, { creating = false } = {}) {
  const id = creating ? normalizeExplicitProviderId(input.id) : undefined;
  const url = parseProviderUrl(input.baseURL);
  if (!url) throw new ProviderConfigError("provider_base_url_invalid");
  if (!Array.isArray(input.models) || input.models.length === 0) throw new ProviderConfigError("provider_models_required");
  return { ...input, ...(id ? { id } : {}), baseURL: url.href.replace(/\/+$/, "") };
}
```

- [ ] **Step 3: Normalize and reconcile a provider-scoped worker assignment**

```js
modelAssignments: {
  ...(normalizeModelRef(source.modelAssignments?.worker, unique) ? {
    worker: normalizeModelRef(source.modelAssignments.worker, unique),
  } : {}),
},
```

- [ ] **Step 4: Run provider configuration/template tests**

Run: `npx vitest --run tests/provider-config.test.ts tests/provider-templates.test.ts`

Expected: all tests pass; template IDs are unique, custom is last, forbidden OAuth/Hermes entries are absent, and assignments reconcile after provider deletion.

### Task 3: Implement bounded gateway-side model discovery

**Files:**
- Create: `core/provider-discovery.js`
- Create: `tests/provider-discovery.test.ts`
- Modify: `core/gateway.js`
- Modify: `tests/gateway-provider.test.ts`

- [ ] **Step 1: Implement a bounded OpenAI-compatible discovery adapter**

```js
export async function discoverProviderModels({ protocol, baseURL, credentials, signal, request = defaultRequest }) {
  if (protocol !== "openai-chat" && protocol !== "openai-responses") {
    throw discoveryError("provider_discovery_unsupported");
  }
  const endpoint = appendEndpoint(baseURL, "models");
  const response = await request(endpoint, {
    signal,
    redirect: "manual",
    headers: credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
  });
  return sanitizeModels(await readBoundedJson(response, 1_048_576), 2_000);
}
```

- [ ] **Step 2: Enforce target and credential safety**

```js
if (isMetadataOrReservedAddress(address)) throw discoveryError("provider_discovery_target_blocked");
if (response.status === 401 || response.status === 403) throw discoveryError("provider_discovery_unauthorized");
if (response.status === 429) throw discoveryError("provider_discovery_rate_limited");
if (response.status >= 300 && response.status < 400) throw discoveryError("provider_discovery_redirect_blocked");
```

- [ ] **Step 3: Add draft and saved-profile routes before the dynamic provider matcher**

```js
// POST /api/providers/discover: body contains draft metadata and ephemeral credentials.
// POST /api/providers/:id/discover: profile metadata and stored credentials come from gateway state.
return sendJson(res, 200, { models, count: models.length });
```

- [ ] **Step 4: Verify stable error mapping and absence of secrets**

Run: `npx vitest --run tests/provider-discovery.test.ts tests/gateway-provider.test.ts`

Expected: tests cover 401/403, 429, timeout, invalid JSON, response cap, redirects, duplicate model IDs, loopback success, blocked metadata targets, and prove credential values never appear in response/errors/config.

### Task 4: Make default and session model selection distinct

**Files:**
- Modify: `core/session-store.js`
- Modify: `core/gateway.js`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/gateway.ts`
- Modify: `src/App.tsx`
- Modify: `tests/gateway-provider.test.ts`

- [ ] **Step 1: Save inherited provider/model metadata when a session is created**

```js
function createSession({ title = "", source = "chat" } = {}) {
  return store.upsertSession({
    id,
    title,
    source,
    providerId: config.activeProviderId,
    modelId: config.activeModelId,
    createdAt: now,
    updatedAt: now,
  });
}
```

- [ ] **Step 2: Validate session model patches without mutating defaults**

```js
const selected = resolveProviderModel(config, body.providerId, body.modelId);
store.upsertSession({ id, providerId: selected.provider.id, modelId: selected.model.id, updatedAt: now });
```

- [ ] **Step 3: Route prompts through the session target**

```js
const target = resolveProviderModel(config, session.providerId, session.modelId, { fallbackToDefault: true });
const activeProvider = target.provider;
const activeModelId = target.model.id;
```

- [ ] **Step 4: Update the Composer picker to patch only the current session**

```ts
onModelChange={(providerId, modelId) => gateway.setSessionModel(currentId, providerId, modelId)
  .then((session) => setSessions((items) => items.map((item) => item.id === session.id ? session : item)))}
```

- [ ] **Step 5: Run session/provider integration tests**

Run: `npx vitest --run tests/gateway-provider.test.ts src/lib/session-sync.test.ts`

Expected: new sessions inherit Settings defaults; Composer changes survive reload for the active session and never change the default provider/model.

### Task 5: Wire the only truthful auxiliary assignment: read-only subagents

**Files:**
- Modify: `core/provider-config.js`
- Modify: `core/gateway.js`
- Modify: `core/engine/types.ts`
- Modify: `core/engine/config/schema.ts`
- Modify: `core/engine/provider/registry.ts`
- Modify: `core/engine/orchestrator/run.ts`
- Modify: `core/engine/orchestrator/run.test.ts`

- [ ] **Step 1: Remove the dead `default/small/plan` UI/config contract**

```ts
// EngineConfig no longer exposes unused providerRoles.
// Migration emits a warning for legacy providerRoles and drops aliases that never had consumers.
```

- [ ] **Step 2: Pass a gateway-owned private worker target to the engine**

```ts
export interface RuntimeModelTarget {
  providerId: string;
  protocol: ProviderProtocol;
  baseURL: string;
  model: string;
  apiKey: string;
  credentials?: ProviderCredentials;
  headers?: Record<string, string>;
}
```

- [ ] **Step 3: Build the child model independently from the main model**

```ts
const workerTarget = opts.workerModel ?? mainTarget;
const workerModel = buildModel({
  protocol: workerTarget.protocol,
  baseURL: workerTarget.baseURL,
  apiKey: workerTarget.apiKey,
  model: workerTarget.model,
  credentials: workerTarget.credentials ?? {},
  headers: workerTarget.headers,
});
```

- [ ] **Step 4: Keep main tuning isolated from worker provider options**

```ts
const mainProviderOptions = buildProviderOptions(opts.providerProtocol, opts.modelParams);
const workerProviderOptions = buildProviderOptions(workerTarget.protocol, undefined);
```

- [ ] **Step 5: Run engine routing tests**

Run: `npm run typecheck:engine && npx vitest --run core/engine/config/config.test.ts core/engine/provider/provider.test.ts core/engine/orchestrator/run.test.ts`

Expected: a configured worker uses its own provider/model/key; inheritance preserves current behavior; main secrets/options never cross provider boundaries.

### Task 6: Replace the provider editor with catalog and draft modal flows

**Files:**
- Create: `src/lib/provider-templates.ts`
- Create: `src/components/settings/providers/ProvidersSettings.tsx`
- Create: `src/components/settings/providers/ProviderCatalog.tsx`
- Create: `src/components/settings/providers/ProviderSetupDialog.tsx`
- Create: `src/components/settings/providers/ModelDiscovery.tsx`
- Create: `src/components/settings/providers/provider-draft.ts`
- Create: `src/components/settings/providers/provider-draft.test.ts`
- Modify: `src/components/Settings.tsx`
- Modify: `src/components/settings/settings-registry.ts`
- Delete: `src/components/settings/ProviderManager.tsx`

- [ ] **Step 1: Add a dedicated Providers section and deep links**

```ts
export type SettingsSectionId = "model" | "chat" | "appearance" | "workspace" | "safety" | "memory" | "voice" | "advanced" | "notifications" | "keybinds" | "providers" | "gateway" | "skills" | "about";
```

- [ ] **Step 2: Render configured providers before available templates and Custom last**

```tsx
<ProviderCatalog
  configured={config.providers}
  templates={templates}
  onConfigure={setDraft}
  onUseDefault={activateProvider}
/>
```

- [ ] **Step 3: Implement a zero-side-effect setup dialog**

```tsx
<ProviderSetupDialog
  open={draft !== null}
  draft={draft}
  onCancel={() => setDraft(null)}
  onDiscover={discoverDraftModels}
  onSave={saveDraft}
/>
```

The dialog exposes Display name, immutable-on-edit ID, protocol, Base URL, credentials-required toggle, protocol-specific secret fields, model discovery, searchable model checkboxes, manual model entry, and an explicit `Use as default` toggle. Cancel performs no gateway mutation.

- [ ] **Step 4: Add accessible discovery states**

```tsx
<div aria-live="polite" role="status">
  {state.kind === "loading" ? t("settings.providers.discovery.loading") : null}
  {state.kind === "success" ? t("settings.providers.discovery.found", { count: state.models.length }) : null}
</div>
```

- [ ] **Step 5: Run renderer tests and hardcode check**

Run: `npm run typecheck:renderer && npx vitest --run src/components/settings/providers/provider-draft.test.ts src/components/settings/settings-copy.test.ts && npm run check:i18n`

Expected: Cancel is pure, custom remains last, duplicate IDs are provider-scoped, and all visible text comes from EN/RU catalogues.

### Task 7: Build the functional Model settings surface

**Files:**
- Create: `src/components/settings/models/ModelSettings.tsx`
- Create: `src/components/settings/models/ModelAssignmentRow.tsx`
- Create: `src/components/settings/models/model-options.ts`
- Create: `src/components/settings/models/model-options.test.ts`
- Modify: `src/components/Settings.tsx`
- Modify: `src/store/model-presets.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add dirty-state default provider/model controls**

```tsx
<ProviderSelect value={draftProviderId} onChange={setDraftProviderId} />
<ModelSelect providerId={draftProviderId} value={draftModelId} onChange={setDraftModelId} />
<Button disabled={!dirty} onClick={applyDefault}>{t("settings.model.apply")}</Button>
```

- [ ] **Step 2: Reuse real per-model reasoning and Fast presets**

```ts
setModelPreset(draftProviderId, draftModelId, { thinking: effort !== "off", effort, fast });
```

- [ ] **Step 3: Show only real auxiliary consumers**

```tsx
<ModelAssignmentRow
  label={t("settings.model.worker.label")}
  description={t("settings.model.worker.description")}
  value={config.modelAssignments.worker}
  inheritLabel={t("settings.model.useMain")}
/>
```

Do not render Vision, Web extract, Compression, Skills hub, Approval, MCP, Title generation, Reviewer, Curator, or Mixture of Agents until each has a runtime consumer and integration test.

- [ ] **Step 4: Run model option/preset tests**

Run: `npx vitest --run src/components/settings/models/model-options.test.ts src/store/settings.test.ts`

Expected: provider-scoped duplicate IDs remain distinct, inheritance is explicit, and saving a worker assignment changes the gateway config rather than local-only state.

### Task 8: Complete navigation, footer actions, localization, and visual verification

**Files:**
- Modify: `src/components/shell/ActivityRail.tsx`
- Modify: `src/components/StatusBar.tsx`
- Modify: `src/components/shell/activity-registry.ts`
- Modify: `src/App.tsx`
- Modify: `src/i18n/locales/en/settings.ts`
- Modify: `src/i18n/locales/ru/settings.ts`
- Modify: `src/i18n/locales/en/shell.ts`
- Modify: `src/i18n/locales/ru/shell.ts`
- Modify: `output/playwright/kyrei-operational-smoke.mjs` (ignored verification artifact)
- Modify: `.omx/state/provider-model-settings/ralph-progress.json` (ignored verification state)

- [ ] **Step 1: Make footer/deep-link actions real buttons**

```tsx
<button type="button" onClick={onHome} aria-label={t("shell.nav.home")}><Home /></button>
<button type="button" onClick={() => onOpenSettings("model")} aria-label={t("shell.nav.settings")}><Settings /></button>
```

Status gateway configuration and Providers activity both open the dedicated Providers section. Settings opens Model.

- [ ] **Step 2: Add complete EN/RU copy and stable error mappings**

Every provider discovery state, template label, modal field, validation error, session/default explanation, and worker assignment uses catalogue keys. Technical provider IDs and model IDs remain data.

- [ ] **Step 3: Run the complete gate**

Run: `npm run gate && npm run build`

Expected: engine and renderer typechecks pass, JS/i18n checks pass, and the full Vitest suite is green.

- [ ] **Step 4: Run real Electron flows**

Automate: open Settings → Providers; open Custom; fill display name/ID/Base URL/ephemeral key; discover models; select a model; save without making default; set it as Settings default; create a new session; switch only that session in Composer; assign Worker; close/reopen Settings; resize to 720×520; close Electron cleanly.

Expected: no secret appears in screenshots or DOM after save; all modals stay within title/status safe areas; keyboard focus remains trapped and restored.

- [ ] **Step 5: Run visual-verdict and persist JSON**

Compare the Providers and Model screenshots against the supplied Hermes references while preserving Kyrei's Linear-inspired palette. Target `score >= 90`; if below, edit and repeat before final handoff.

---

## Self-review

- Spec coverage: predefined providers, custom ID/display name/key/Base URL/models, discovery, default model, session hot-swap, real worker assignment, navigation, EN/RU, secret handling, and Electron verification are all mapped to tasks.
- Intentionally excluded from this delivery: browser OAuth/accounts, Hermes/Nous proprietary provider, cosmetic auxiliary roles without runtime consumers, and Mixture of Agents without an aggregator implementation.
- No secret values are present in this plan, fixtures, screenshots, or commands.
- Type consistency: public renderer uses `ModelRef`; gateway resolves it into private `RuntimeModelTarget`; sessions use `providerId`/`modelId`; main defaults remain `activeProviderId`/`activeModelId`.
