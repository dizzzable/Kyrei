# Research Brief: GBrain and native provider runtime

**Depth**: focused
**Date**: 2026-07-13

## Executive summary

Kyrei should keep one provider registry but dispatch models through explicit
transport adapters. OpenAI-compatible Chat Completions remains the broad custom
endpoint path; OpenAI Responses, Anthropic Messages, Google Generative AI, and
Amazon Bedrock require native adapters with provider-scoped authentication.

GBrain is useful as an optional world-knowledge brain, not as a replacement for
Kyrei's project memory. The clean boundary is a local/remote adapter that exposes
search, synthesis, and capture as agent tools while keeping returned knowledge
untrusted and never injecting it automatically into system instructions.

## Local evidence

- Kyrei currently uses AI SDK 5.0.210 and provider protocol v2.
- AI SDK's `ai-v5` dist-tags resolve to compatible native packages:
  `@ai-sdk/openai@2.0.110`, `@ai-sdk/anthropic@2.0.85`,
  `@ai-sdk/google@2.0.78`, and `@ai-sdk/amazon-bedrock@3.0.105`.
- The current Kyrei registry already separates public provider metadata from
  API-key secrets and pins fallbacks to the active endpoint.
- GBrain 0.42.58.0 is MIT, Bun-based, supports PGLite locally, and exposes a
  stable `gbrain call <operation> <json>` local interface plus MCP stdio/HTTP.

## Architecture recommendation

### Provider transports

| Transport | Adapter | Authentication | Priority |
|---|---|---|---|
| OpenAI-compatible chat | existing `@ai-sdk/openai-compatible` | API key | keep |
| OpenAI Responses | `@ai-sdk/openai` | API key | first |
| Anthropic Messages | `@ai-sdk/anthropic` | API key | first |
| Google Generative AI | `@ai-sdk/google` | API key | implemented |
| Amazon Bedrock Converse | `@ai-sdk/amazon-bedrock` | bearer or AWS key/secret/session/region | implemented |
| Vertex AI | `@ai-sdk/google-vertex` | Google service account | implemented |

Provider secrets must be shaped by protocol. A fallback candidate may reuse
credentials only inside the same provider profile.

### GBrain

Use an opt-in `gbrain` memory configuration with modes `off`, `read`, and
`read-write`. Run the executable without a shell and pass JSON as an argv value;
bound time/output and support cancellation. Expose:

- `brain_search` -> `gbrain call search`;
- `brain_think` -> `gbrain call think` without persistence flags;
- `brain_capture` -> `gbrain capture --stdin --json` only in read-write mode.

Do not vendor GBrain, do not share provider secrets with it automatically, and
do not auto-inject brain output into the system prompt. GBrain maintains a
separate Markdown brain repository; Kyrei remains usable if the command is
missing.

## Risks

- Native provider packages must match AI SDK 5 rather than current `latest`.
- The pinned AI SDK 5 line currently inherits low-severity
  `GHSA-866g-f22w-33x8` in `@ai-sdk/provider-utils`; npm offers only
  semver-major AI SDK upgrades as a fix, so migration needs a separate tested
  compatibility pass.
- Bedrock has a multi-secret credential model and must not be forced into the
  single API-key field.
- GBrain synthesis can incur its own model cost and may contain prompt-like
  content; outputs need explicit untrusted-data framing.
- Installing GBrain is reversible, but initializing a brain should wait until a
  storage location and embedding provider are chosen.

## Implemented result

Kyrei now dispatches all six transport families through pinned AI SDK v5
packages and stores Bedrock/Vertex credentials in an allowlisted gateway-only
secret record. GBrain 0.42.58.0 was installed globally through Bun and its fast
doctor command runs; no brain/database was initialized. The optional adapter
has read/read-write modes, process-tree cancellation, and a separate cap for
model-facing untrusted data.

## Sources

- https://github.com/garrytan/gbrain
- https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md
- https://github.com/garrytan/gbrain/blob/master/docs/mcp/CODEX.md
- https://ai-sdk.dev/docs/foundations/providers-and-models
- https://ai-sdk.dev/docs/ai-sdk-core/provider-management
- https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
- https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
