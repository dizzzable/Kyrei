---
name: secret-hygiene
description: Use when handling credentials, .env files, tokens, or redaction — keep secrets out of git, chat, tools, and memory. Opt-in Kyrei security pack.
tags: [security, secrets]
version: "1.0.0"
author: kyrei-pack
---

# Secret hygiene

## Never

- Commit `.env`, key files, or cookie jars.
- Send API keys to web_search, web_fetch, MCP, or third-party paste services.
- Write secrets into MEMORY.md, notes, handoffs, or skill bodies.
- Log full Authorization headers or provider payloads with keys.

## Prefer

- Environment variables and Kyrei provider secret storage.
- Redacted examples: `sk-***`, `Bearer ***`.
- Scoped tokens with minimal permissions and expiry.

## If a secret may have leaked

1. Stop further distribution (revert commit if needed; rotate immediately).
2. Tell the user which surface may have been exposed (file path / tool / chat).
3. Do not re-print the secret while diagnosing.
