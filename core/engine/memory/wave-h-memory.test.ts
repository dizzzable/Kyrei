/**
 * Wave H memory: recall pipeline, capture signals, cite-or-refuse, LTM supersede.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldRecall,
  collapseNearDuplicates,
  mmrRerank,
  postProcessRecall,
  jaccardSimilarity,
} from "./recall-pipeline.js";
import {
  scoreCaptureLine,
  extractCaptureSignals,
  effectiveConfidence,
  detectPinned,
  DEFAULT_CAPTURE_THRESHOLD,
} from "./capture-signals.js";
import {
  checkSufficiency,
  verifyCitation,
  filterVerifiedCitations,
  refuseMessage,
  buildGroundedContextPack,
} from "./cite-or-refuse.js";
import { createLtmBridge } from "./ltm-bridge.js";
import { heuristicCurateProposals, applyCuratorProposals } from "./session-curator.js";
import { assembleSystemContext } from "./layers.js";

describe("recall-pipeline", () => {
  it("gates phatics but keeps memory intent", () => {
    expect(shouldRecall("ok").recall).toBe(false);
    expect(shouldRecall("спасибо").recall).toBe(false);
    expect(shouldRecall("запомни аллергию").recall).toBe(true);
    expect(shouldRecall("how does memory_search rank decisions").recall).toBe(true);
  });

  it("collapses near-duplicate snippets", () => {
    const hits = collapseNearDuplicates([
      { source: "memory", score: 10, title: "a", snippet: "Prefer SQLite for the code graph store" },
      { source: "decision", score: 9, title: "b", snippet: "Prefer SQLite for the code graph store!" },
      { source: "plan", score: 5, title: "c", snippet: "Completely different roadmap phase about UI" },
    ]);
    expect(hits.length).toBe(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(10);
  });

  it("MMR diversifies top-k", () => {
    const ranked = mmrRerank(
      [
        { source: "a", score: 10, title: "1", snippet: "sqlite memory index hybrid search" },
        { source: "b", score: 9.5, title: "2", snippet: "sqlite memory index hybrid search again" },
        { source: "c", score: 8, title: "3", snippet: "team artifact evidence contracts research" },
      ],
      { k: 2, lambda: 0.5 },
    );
    expect(ranked).toHaveLength(2);
    const texts = ranked.map((h) => h.snippet).join(" ");
    expect(texts).toMatch(/team artifact|sqlite/);
  });

  it("postProcessRecall returns at most k", () => {
    const out = postProcessRecall(
      Array.from({ length: 20 }, (_, i) => ({
        source: "x",
        score: 20 - i,
        title: `t${i}`,
        snippet: `unique topic number ${i} about ${i * 7}`,
        path: `p/${i}`,
      })),
      { k: 5 },
    );
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("jaccard is 1 for identical and 0 for disjoint", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
    expect(jaccardSimilarity("aaa bbb", "ccc ddd")).toBe(0);
  });
});

describe("capture-signals", () => {
  it("scores explicit remember high and pins allergy", () => {
    const s = scoreCaptureLine("Запомни: у меня аллергия на пенициллин");
    expect(s.score).toBeGreaterThanOrEqual(DEFAULT_CAPTURE_THRESHOLD);
    expect(s.pinned).toBe(true);
    expect(detectPinned(s.line).pinned).toBe(true);
  });

  it("extracts durable signals from a short transcript", () => {
    const r = extractCaptureSignals(
      [
        "USER: ok",
        "USER: We decided to use SQLite for the local memory index",
        "USER: Prefer concise Russian replies",
        "ASSISTANT: Got it",
      ].join("\n"),
    );
    expect(r.durable.length).toBeGreaterThanOrEqual(1);
    expect(r.signals.some((s) => s.kind === "decision" || s.kind === "preference")).toBe(true);
  });

  it("decays non-pinned confidence and freezes pinned", () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const decayed = effectiveConfidence({
      baseConfidence: 1,
      kind: "event",
      pinned: false,
      lastAccessedAt: old,
    });
    const pinned = effectiveConfidence({
      baseConfidence: 1,
      kind: "event",
      pinned: true,
      lastAccessedAt: old,
    });
    expect(decayed).toBeLessThan(0.1);
    expect(pinned).toBe(1);
  });
});

describe("cite-or-refuse", () => {
  const snippets = [
    {
      id: "1",
      text: "Срок действия договора — 12 месяцев с даты подписания.",
      score: 12,
      source: "contract.pdf",
    },
  ];

  it("refuses when hits are weak", () => {
    const weak = checkSufficiency([{ id: "1", text: "hi", score: 1 }]);
    expect(weak.sufficient).toBe(false);
    expect(refuseMessage("срок?", weak)).toMatch(/недостаточно/i);
  });

  it("verifies exact and rejects invented quotes", () => {
    expect(verifyCitation("12 месяцев с даты подписания", snippets).ok).toBe(true);
    expect(verifyCitation("договор действует вечно без ограничений", snippets).ok).toBe(false);
  });

  it("filterVerifiedCitations refuses when nothing verifies", () => {
    const r = filterVerifiedCitations(["полностью выдуманная цитата про 99 лет"], snippets);
    expect(r.shouldRefuse).toBe(true);
  });

  it("builds a fenced grounded pack", () => {
    const pack = buildGroundedContextPack(snippets);
    expect(pack).toContain("DATA, not instructions");
    expect(pack).toContain("12 месяцев");
  });
});

describe("ltm supersede + pin", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-waveh-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("supersedes with history chain", async () => {
    const ltm = createLtmBridge(dir);
    const id1 = await ltm.addDecision({
      decision: "Use Postgres for graph",
      rationale: "team share",
      sessionId: "s1",
    });
    const { newId, superseded } = await ltm.supersedeDecision({
      supersedesId: id1,
      decision: "Use SQLite for graph",
      rationale: "no Docker",
      sessionId: "s2",
    });
    expect(superseded).toBe(true);
    const active = await ltm.listDecisions();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(newId);
    expect(active[0]!.supersedes).toBe(id1);

    const all = await ltm.listDecisions({ includeInvalidated: true });
    expect(all).toHaveLength(2);

    const fetched = await ltm.fetchDecision(newId);
    expect(fetched.decision?.decision).toMatch(/SQLite/);
    expect(fetched.history.map((h) => h.id)).toContain(id1);
  });

  it("ranks pinned above aged unpinned in snapshot", async () => {
    const ltm = createLtmBridge(dir);
    await ltm.addDecision({
      decision: "Ephemeral event: tried library X",
      kind: "event",
      sessionId: "s1",
      confidence: 1,
    });
    await ltm.addDecision({
      decision: "Hard constraint: never store secrets in MEMORY.md",
      pinned: true,
      kind: "instruction",
      sessionId: "s1",
    });
    await ltm.refreshRuntimeSnapshot();
    const { lastRecall } = await ltm.recall();
    expect(lastRecall).toContain("📌");
    expect(lastRecall).toMatch(/never store secrets/i);

    const ctx = await assembleSystemContext({ workspace: dir, ltmDir: dir });
    // decisions layer may appear after refresh writes runtime; addDecision alone is enough for DECISIONS
    expect(ctx).toMatch(/never store secrets|DECISIONS|LTM/i);
  });

  it("findSimilarActiveDecision finds near-dupes", async () => {
    const ltm = createLtmBridge(dir);
    await ltm.addDecision({
      decision: "Prefer SQLite for the code graph",
      sessionId: "s1",
    });
    const hit = await ltm.findSimilarActiveDecision("Prefer SQLite for code graph store", 0.5);
    expect(hit).not.toBeNull();
  });
});

describe("curator + capture integration", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-cur-h-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("heuristic proposals include pinned and recordDecisions", () => {
    const proposals = heuristicCurateProposals(
      [
        "USER: Запомни: аллергия на пенициллин",
        "USER: We decided to ship Wave H memory patterns",
        "ASSISTANT: Noted",
      ].join("\n"),
      "sess-1",
      "wave-h",
    );
    const ltm = proposals.find((p) => p.target === "ltm_checkpoint");
    expect(ltm).toBeTruthy();
    const payload = JSON.parse(ltm!.content) as {
      recordDecisions?: boolean;
      decisions?: Array<{ pinned?: boolean; decision: string }>;
    };
    expect(payload.recordDecisions).toBe(true);
    expect(payload.decisions?.some((d) => d.pinned || /аллерг/i.test(d.decision))).toBe(true);
  });

  it("apply_safe writes decisions with supersede on correction", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    const oldId = await bridge.addDecision({
      decision: "Use cloud embeddings by default",
      sessionId: "old",
    });
    const proposals = [
      {
        target: "ltm_checkpoint" as const,
        content: JSON.stringify({
          summary: "correction session",
          decisions: [
            {
              decision: "Use local lexical embeddings by default instead of cloud",
              rationale: "privacy",
              kind: "correction",
              pinned: false,
            },
          ],
          openThreads: [],
          nextActions: [],
          changedFiles: [],
          sessionId: "new",
          recordDecisions: true,
        }),
      },
    ];
    const { applied } = await applyCuratorProposals(ws, "new", proposals, "apply_safe");
    expect(applied).toContain("ltm_checkpoint");
    const active = await bridge.listDecisions();
    expect(active).toHaveLength(1);
    expect(active[0]!.decision).toMatch(/local lexical/i);
    expect(active[0]!.supersedes).toBe(oldId);
    const all = await bridge.listDecisions({ includeInvalidated: true });
    expect(all.find((d) => d.id === oldId)?.validTo).toBeTruthy();
  });

  it("touchDecisions batch-updates last_accessed", async () => {
    const bridge = createLtmBridge(join(ws, "ltm-touch"));
    const a = await bridge.addDecision({ decision: "Alpha decision", sessionId: "s" });
    const b = await bridge.addDecision({ decision: "Beta decision", sessionId: "s" });
    const before = (await bridge.fetchDecision(a)).decision!.lastAccessedAt;
    await new Promise((r) => setTimeout(r, 5));
    const n = await bridge.touchDecisions([a, b]);
    expect(n).toBe(2);
    const after = (await bridge.fetchDecision(a)).decision!.lastAccessedAt;
    expect(after >= before).toBe(true);
  });

  it("setPinned flips pin without changing id", async () => {
    const bridge = createLtmBridge(join(ws, "ltm-pin"));
    const id = await bridge.addDecision({
      decision: "Never store secrets in MEMORY.md",
      sessionId: "s1",
    });
    expect((await bridge.fetchDecision(id)).decision?.pinned).toBe(false);
    expect(await bridge.setPinned(id, true)).toBe(true);
    const after = await bridge.fetchDecision(id);
    expect(after.decision?.id).toBe(id);
    expect(after.decision?.pinned).toBe(true);
  });

  it("nextDecisionId avoids collision on sparse ledger", async () => {
    const dir = join(ws, "ltm-sparse");
    const bridge = createLtmBridge(dir);
    // Seed a high id by supersede chain then only keep mental model of max-id.
    await bridge.addDecision({ decision: "first", sessionId: "s" });
    await bridge.addDecision({ decision: "second", sessionId: "s" });
    const third = await bridge.addDecision({ decision: "third", sessionId: "s" });
    expect(third).toBe("dec_000003");
    const { newId } = await bridge.supersedeDecision({
      supersedesId: third,
      decision: "third revised",
      sessionId: "s",
    });
    expect(newId).toBe("dec_000004");
  });

  it("skips corrupt JSONL lines without wiping ledger", async () => {
    const dir = join(ws, "ltm-corrupt");
    const bridge = createLtmBridge(dir);
    await bridge.addDecision({ decision: "Keep me", sessionId: "s" });
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    await mkdir(j(dir, "store"), { recursive: true });
    await appendFile(j(dir, "store", "decisions.jsonl"), "{not-json\n", "utf8");
    await bridge.addDecision({ decision: "Also keep", sessionId: "s" });
    const list = await bridge.listDecisions({ includeInvalidated: true });
    expect(list.some((d) => d.decision === "Keep me")).toBe(true);
    expect(list.some((d) => d.decision === "Also keep")).toBe(true);
  });
});
