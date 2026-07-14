# Model capability metadata

Kyrei treats model limits and media/tool support as data with provenance, not
as properties inferred from a model-name substring.

## Resolution order

1. Explicit fields returned by the configured provider's live model catalog.
2. Missing fields from an exact canonical endpoint + provider + model id
   curated registry entry.
3. `unknown` — no context-window or capability defaults are invented.
4. A user override affects the effective local limit, while the detected value
   and its provenance remain visible. Bounded overrides are also forwarded to
   the engine: context controls primary-model compaction and maximum output is
   sent as AI SDK `maxOutputTokens`. Fallback models never inherit them.

Live metadata is normalized by `core/model-capabilities.js`. Only bounded token
counts, booleans, and the `text`, `image`, `audio`, `video`, and `file` modalities are
retained. Arbitrary provider fields and URLs are discarded before persistence.

## Supported catalog contracts

- OpenAI-compatible `GET /models`. The first-party OpenAI response contains
  only basic identity/ownership fields; extended limits are accepted only when
  a compatible provider explicitly returns them.
- Anthropic `GET /v1/models` (`max_input_tokens`, `max_tokens`, capabilities).
- Gemini `GET /v1beta/models` (`inputTokenLimit`, `outputTokenLimit`, thinking).

Bedrock and Vertex remain unknown until their provider-specific discovery can
be implemented without pretending that one deployment-wide limit applies to
every regional model endpoint.

## Curated entries

The registry is intentionally small. Every alias or snapshot must be a separate
exact key, must cite an official source, and is used only for its canonical
first-party endpoint. A custom proxy with the same model id stays unknown until
its live catalog reports metadata or the user supplies an override. Current references:

- [OpenAI GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Gemini 2.5 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)
- [DeepSeek model details](https://api-docs.deepseek.com/quick_start/pricing-details-usd/)

To add a model, add exact IDs to `core/model-capabilities.js`, cite the official
model page, and cover the new entry with a test. Do not add wildcard, prefix, or
fuzzy matching.
