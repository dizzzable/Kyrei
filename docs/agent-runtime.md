# Kyrei: agent runtime extensions

## Agent-only web access

Kyrei exposes `web_search` and `web_fetch` only to the agent tool loop. It
does not create Electron tabs, execute page JavaScript, reuse browser cookies,
or open URLs in the OS. Public web content is treated as untrusted reference
material.

The reader allows only public HTTP(S) targets, rejects local/private/reserved
networks (including IPv4-mapped IPv6), pins each request to the validated DNS
address, validates every redirect again, caps response size, and keeps a
deadline through body streaming. Access is controlled by
`engine.permissions.web`: `off`, `search`, or `read`.

The local gateway has a per-launch capability token. The renderer receives it
only through its launch URL and sends it on every JSON call; SSE uses the token
only on the events route because EventSource cannot set headers. The gateway is
loopback-bound, checks origin, and never uses wildcard CORS.

## Provider registry

The settings UI manages an unbounded list of provider profiles. A profile has
a stable id, display name, URL, model list, enabled state, API-key requirement,
and non-secret custom headers. API keys are stored separately from the public
configuration and are never returned to the renderer.

The shipping built-in transports are:

- `openai-chat` for OpenAI-compatible Chat Completions endpoints, including
  Ollama/LM Studio;
- `openai-responses` for native OpenAI Responses API endpoints; and
- `anthropic-messages` for native Anthropic Messages API endpoints;
- `google-generative-ai` for Gemini through Google AI Studio;
- `amazon-bedrock` for Bedrock Converse with bearer or AWS SigV4 credentials;
- `google-vertex` for Vertex AI with a service account.

Provider fallbacks stay on the same endpoint until Kyrei has credentials scoped
to every fallback profile; a key is never reused with an unrelated provider.
Public provider profiles participate in settings export/import, while their
credentials are deliberately excluded and must be restored locally.

Bedrock and Vertex multi-field credentials are allowlisted into
`kyrei-secrets.json` and are never returned by the gateway. Packaged desktop
builds encrypt this file with Electron `safeStorage` when the operating-system
keyring is available; Unix fallback files are kept at mode `0600`. Other hosted vendors
(OpenRouter, DeepSeek, Kimi, Together-style services) and local Ollama/LM Studio
instances use unlimited OpenAI-compatible profiles. Hermes/Nous proprietary
runtime, MoA, Copilot ACP, and Codex app-server are intentionally not disguised
as ordinary HTTP providers.

## Local project intelligence and optional OpenViking

`project_index` creates a deterministic, provenance-labelled import graph in
`.kyrei/intel`; `project_map` and `project_impact` query it. The graph is tool
data, not a system-instruction layer, so a repository cannot inject directives
by committing an index file.

Kyrei's existing local memory remains the canonical offline default. The
optional OpenViking client is a narrow loopback-only HTTP adapter and is not
vendored into Kyrei. Start its upstream service with:

```powershell
docker compose -f docker/openviking/compose.yml up -d
docker exec -it kyrei-openviking openviking-server init
```

The compose definition binds port 1933 only to `127.0.0.1`, disables VikingBot,
and stores OpenViking's setup/key material in a Docker-managed volume rather
than the repository. The service remains opt-in; Kyrei works normally without
Docker.

## Optional GBrain knowledge layer

GBrain is integrated through its local CLI contract rather than vendored into
Kyrei. Enable it under Advanced settings with `read` or `read-write` access.
The agent receives `brain_search`, `brain_get`, `brain_think`, and
`brain_status`; `brain_capture` exists only in `read-write` mode.

Every process is launched without a shell, has bounded time and output, and is
terminated as a process tree on timeout or cancellation. Results are clipped to
Kyrei's model-facing tool limit and marked as untrusted personal knowledge.
They are never auto-injected into system instructions and GBrain never receives
Kyrei provider credentials.

Install the independent runtime with Bun:

```powershell
bun add --global github:garrytan/gbrain
gbrain --version
```

Kyrei does not run `gbrain init` automatically. The user chooses a separate
Markdown brain repository, storage backend, and embedding provider first; the
built-in SQLite/project memory remains the offline canonical source.
