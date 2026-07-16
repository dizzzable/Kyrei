# Research: Multi-platform session / memory import into Kyrei

**Date:** 2026-07-16  
**Goal:** Understand how major AI coding / chat platforms store and export conversations, so Kyrei can import *useful memory* (not raw dumps).

**Principle (non-negotiable):**  
`normalize → redact → distill → store`  
Target stores: `.kyrei/handoff/`, LTM events, optional short Kyrei session seed.  
**Not** replaying foreign tool-calls as live Kyrei tools.

---

## 1. Canonical intermediate model (Kyrei)

All adapters should normalize into one shape before distill:

```ts
interface ImportedTranscript {
  source: string;           // "cursor" | "claude-code" | "chatgpt" | ...
  sourceId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  workspaceHint?: string;   // project path if known
  messages: Array<{
    role: "user" | "assistant" | "system" | "tool" | "unknown";
    text: string;           // plain text only after flatten
    at?: string;
    // optional provenance for distill heuristics
    parts?: Array<{ type: string; text?: string }>;
  }>;
  meta?: Record<string, unknown>;
}
```

**Distill output** (reuse handoff shape):

- intent, done, nextActions, keyFiles, decisions, openQuestions, constraints  
→ write `.kyrei/handoff/<id>.md` + optional LTM event + optional seed message in a new Kyrei session.

---

## 2. Platform matrix

| Platform | Official export | Local storage | Machine format | Difficulty | Priority for Kyrei | Notes |
|----------|-----------------|---------------|----------------|------------|--------------------|-------|
| **OpenCode** | `opencode export` / `import` JSON; share URL | `~/.local/share/opencode/opencode.db` (+ session parts) | SQLite + JSON messages/parts | **Easy** | **P0** | First-class import/export exists; we already reverse-engineered schema |
| **Hermes** | Desktop/export paths vary | `state.db` sessions/messages; `hermes/sessions/` dumps | SQLite + JSON | **Easy–Med** | **P0** | Bundled in Kyrei tree; same product family |
| **Kyrei (self)** | Sidebar JSON export | gateway session store | `SessionExport` messages | **Easy** | **P0** | Round-trip baseline |
| **Claude Code (CLI)** | `/export` → Markdown; raw project files | `~/.claude/projects/<project>/*.jsonl` | JSONL per session | **Easy–Med** | **P0** | Best coding-agent source of truth |
| **Claude.ai (web)** | Settings → Privacy → Export Data ZIP | n/a (cloud) | `conversations.json` array (`sender`, `text`/`content`) | **Easy** | **P1** | Account-wide, not project-scoped |
| **ChatGPT** | Settings → Data controls → Export ZIP | n/a | `conversations.json` **tree** (`mapping` + parent links) | **Med** | **P1** | Need walk `current_node` parents; branches |
| **Cursor** | Per-chat Markdown (UI); community CLI JSON/MD | `%APPDATA%/Cursor/User/workspaceStorage/*/state.vscdb` (+ globalStorage) | SQLite (VS Code-style), undocumented | **Hard** | **P1** | Path-hash workspace binding; formats drift |
| **Kiro IDE** | Right-click chat → Export Conversation **.md** | IDE-managed | Markdown | **Easy** | **P1** | Specs (`.kiro/specs`) are *better* memory than chat |
| **Kiro CLI** | `/chat save <path>` | per-directory DB | JSON file export | **Easy–Med** | **P1** | Docs: session save/load/resume |
| **Aider** | Project files | `.aider.chat.history.md`, input history | Markdown chat log | **Easy** | **P2** | Already in-repo, readable |
| **Windsurf / Cascade** | Weak official export | `~/.codeium/…`, memories under `~/.codeium/windsurf/memories/` | Mixed / proprietary | **Hard** | **P3** | Memories MD more useful than full chat |
| **GitHub Copilot Chat** | Limited | VS Code storage | proprietary | **Hard** | **P3** | Low ROI initially |
| **Cline / Continue / Roo** | Varies (often open) | extension storage / project files | often JSON/MD | **Med** | **P2** | Treat as “generic JSON/MD” adapters |
| **Grok / X / web UIs** | Usually copy/export limited | n/a | freeform | **Med** | **P3** | Paste-as-markdown adapter covers them |

---

## 3. Per-platform detail (engineering notes)

### 3.1 OpenCode (P0)

| | |
|--|--|
| **Export** | `opencode export [sessionID]` → JSON; `--sanitize` |
| **Import** | `opencode import <file\|share-url>` |
| **Local DB** | `opencode.db`: `session`, `message`, `part` (text/tool/reasoning/…) |
| **Adapter** | Prefer official export JSON; fallback: read DB with user consent |
| **Value** | High — full coding agent sessions with tools |

### 3.2 Hermes (P0)

| | |
|--|--|
| **Storage** | `state.db` tables `sessions` / `messages`; optional JSON under `sessions/` |
| **Adapter** | Direct SQL or Hermes export if available; map roles → Kyrei messages |
| **Value** | High — already on machine with Kyrei |

### 3.3 Claude Code (P0)

| | |
|--|--|
| **Export** | `/export file.md` |
| **Local** | `~/.claude/projects/<slug>/*.jsonl` |
| **Adapter** | JSONL line parser + MD export parser |
| **Value** | Very high for coding decisions |

### 3.4 Claude.ai (P1)

| | |
|--|--|
| **Export** | Privacy data export ZIP → JSON conversations |
| **Shape** | Array of chats; messages with `sender: human\|assistant`, `text` / content blocks |
| **Adapter** | Flatten content blocks to text; skip attachments binaries |

### 3.5 ChatGPT (P1)

| | |
|--|--|
| **Export** | Account data export ZIP |
| **Shape** | `conversations.json`: each convo has `mapping` graph, `current_node` |
| **Adapter** | Walk parent chain from leaf; extract `author.role` + `content.parts[]` |
| **Caveat** | Tool/multimodal nodes; DALL·E pointers — drop or stub |

### 3.6 Cursor (P1)

| | |
|--|--|
| **Official** | Export chat to Markdown (single conversation) |
| **Local** | `state.vscdb` SQLite under workspaceStorage hashes |
| **Tools** | Community: `cursor-history` CLI (list/export JSON/MD) |
| **Adapter** | (1) MD export, (2) optional SQLite reader with version pin + tests |
| **Caveat** | Schema changes without notice; workspace path renames “lose” chats |

### 3.7 Kiro (P1)

| | |
|--|--|
| **IDE** | Export conversation → **Markdown** |
| **CLI** | `/chat save path.json`, resume/load |
| **Specs** | `.kiro/specs/**` design/requirements/tasks — **import as project memory**, not chat |
| **Adapter** | MD + JSON save formats; separate “import Kiro specs” → steering/handoff |

### 3.8 Aider (P2)

| | |
|--|--|
| **Files** | `.aider.chat.history.md` in project |
| **Adapter** | Markdown role sections / chronological log |
| **Value** | Easy win for repo-local history |

### 3.9 Windsurf (P3)

| | |
|--|--|
| **Export** | Poor / community complaints |
| **Memories** | `~/.codeium/windsurf/memories/` (MD rules) |
| **Adapter** | Prefer memories MD over full Cascade history |

---

## 4. Adapter architecture (recommended)

```
src/lib/session-import/          # or core/engine/memory/import/
  types.ts                       # ImportedTranscript
  detect.ts                      # sniff format from file/zip
  redact.ts                      # reuse session-export secret patterns + more
  distill.ts                     # → HandoffArtifact (+ optional LTM)
  adapters/
    kyrei-export.ts
    opencode-json.ts
    opencode-db.ts               # optional advanced
    hermes-db.ts
    claude-code-jsonl.ts
    claude-code-md.ts
    claude-ai-export.ts
    chatgpt-export.ts
    cursor-md.ts
    cursor-vscdb.ts              # later
    kiro-md.ts
    kiro-cli-json.ts
    aider-md.ts
    generic-md.ts                # paste / unknown
  index.ts                       # importTranscript(file) → ImportedTranscript
```

**Gateway:** `POST /api/import/transcript` → distill → write handoff → optional create session.

**UI:** Settings or Sidebar → “Import conversation…” (file picker: `.json`, `.jsonl`, `.md`, `.zip`).

---

## 5. Phased delivery

| Phase | Scope | Outcome |
|-------|--------|---------|
| **A** | Intermediate model + redact + distill → handoff/LTM | Works for *any* adapter |
| **B** | Adapters: Kyrei, OpenCode export, Claude Code JSONL/MD, generic MD | Covers daily coding tools |
| **C** | ChatGPT ZIP, Claude.ai ZIP, Kiro MD/JSON, Aider MD | Account/project dumps |
| **D** | Cursor SQLite (+ optional community CLI path), Hermes DB | High value, brittle |
| **E** | Windsurf memories, Copilot, Cline/Continue | Long tail |

---

## 6. Risks & policies

1. **Secrets** — always redact before persist/display.  
2. **Untrusted content** — imported text is *data*, not instructions (same as web).  
3. **PII** — optional strip emails/phones.  
4. **Size** — refuse > N MB raw; distill always.  
5. **Legal** — only user-owned exports; no scraping cloud APIs with stolen cookies.  
6. **Schema drift** — pin adapter versions; golden fixtures per platform.  
7. **Workspace match** — prefer imports that include project path; else user picks workspace.

---

## 7. What we should *not* do

- Replay foreign tool calls as Kyrei tools.  
- Load 50 full sessions into one context window.  
- Depend on private APIs without user-initiated export files.  
- Treat proprietary SQLite as stable contract without fixtures + fallbacks.

---

## 8. Decision

**Yes: multi-platform import is worth it**, if framed as **memory import**, not session clone.

**Start order:**  
1. Canonical model + distill (Phase A)  
2. OpenCode + Claude Code + Kyrei + generic MD (Phase B)  
3. ChatGPT/Claude ZIP + Kiro (Phase C)  
4. Cursor SQLite only after MD path works (Phase D)

---

## 9. Next concrete step

**Done (2026-07-16):** full Kiro-style spec for Phase A+B:

- `.kiro/specs/session-memory-import/requirements.md`
- `.kiro/specs/session-memory-import/design.md`
- `.kiro/specs/session-memory-import/tasks.md`

**Implemented (2026-07-16) Phase A+B core:**

- Engine: `core/engine/memory/import/*` (detect, adapters, redact, distill, orchestrate)
- Gateway: `POST /api/import/transcript`
- UI: Sidebar upload (import conversation)
- Tests: `import.test.ts`, `session-import-gateway.test.ts`; full `npm run gate` green

Still deferred: ChatGPT/Claude ZIP, Cursor SQLite, Hermes DB, Kiro JSON (Phase C–D).
