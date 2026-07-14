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

## Skills and evidence-first Team research

A Skill is complete when its folder contains `SKILL.md`; linked documents are
optional progressive references, not a requirement. Kyrei advertises compact
metadata first, then a matching agent loads only the needed `SKILL.md` with
`read_skill`. Long standalone instructions are read in bounded chunks using the
returned offset, so they do not need to be copied into separate documents.
`search_skills` finds the relevant assigned Skills without loading their
instructions. Selecting a Skill for a Team role automatically grants that
read-only role the Skill-read capability; it cannot become a dead assignment.

Team research follows one contract: read the assigned Skills, project context,
and local evidence first; use web search only to discover candidate sources;
fetch a public primary or official source before treating a claim as observed;
state uncertainty and unchecked work in the final artifact. Search snippets are
never evidence. A successful direct fetch also mints a runtime source receipt
(requested/final URL, title, content digest, and timestamp); only that compact
metadata is passed to dependent roles, never a page body or model-written URL.
Within one Team run, identical permitted searches and page fetches reuse a
small in-memory result; the cache is discarded when the run ends and never
becomes cross-session memory.

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
Kyrei. Configure it under **Settings → Memory** with `read` or `read-write`
access. The screen first checks the local CLI and shows one of three clear
states: ready, installed but not initialized, or unavailable.
The agent receives `brain_search`, `brain_get`, `brain_think`, and
`brain_status`; `brain_capture` exists only in `read-write` mode.

Every process is launched without a shell, has bounded time and output, and is
terminated as a process tree on timeout or cancellation. Results are clipped to
Kyrei's model-facing tool limit and marked as untrusted personal knowledge.
They are never auto-injected into system instructions and GBrain never receives
Kyrei provider credentials.

Install the independent runtime with Bun:

```powershell
bun install -g github:garrytan/gbrain
gbrain --version
```

After the status check says that local memory is not initialized, click
**Initialize local memory**. This is the only path where Kyrei invokes
`gbrain init --pglite --no-embedding`: it creates an empty local PGLite store,
does not open a browser, install software, select an embedding model, or send
an external key. Kyrei enables `read` access only after a successful follow-up
health check. It never initializes GBrain automatically during startup.

If the command is unavailable, install GBrain independently or set the command
field to an existing local executable and check again. The built-in
SQLite/project memory remains Kyrei's offline canonical source; GBrain stays
an optional, untrusted retrieval layer.
