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

The shipping transport is `openai-chat` (OpenAI-compatible Chat Completions),
which covers compatible hosted endpoints plus Ollama/LM Studio. Provider
fallbacks stay on the same endpoint until Kyrei has credentials scoped to every
fallback profile; a key is never reused with an unrelated provider.

Hermes' additional transport families are intentionally not presented as
working custom endpoints yet: OpenAI Responses, Anthropic Messages, Gemini
native, and Bedrock Converse each need a dedicated request/tool translation and
their own authentication model. The registry is the shared base for those
adapters; no Hermes/Nous native provider or proprietary runtime is copied.

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
