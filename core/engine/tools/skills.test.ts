import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { buildSkillTools } from "./skills.js";

const skills = [
  {
    id: "skill-review",
    name: "Code review",
    description: "Review TypeScript changes",
    provenance: "global" as const,
    content: "# Review\n\nCheck correctness before style.",
  },
];

const skillsWithDocuments = [{
  ...skills[0],
  documents: [{
    id: "doc-official",
    label: "Official reference",
    relativePath: "official/source.md",
    source: "kiro-docs" as const,
  }],
}];

const readDocument = vi.fn(async (skillId: string, documentId: string) => ({
  skillId,
  id: documentId,
  label: "Official reference",
  relativePath: "official/source.md",
  source: "kiro-docs" as const,
  content: "# Official\n\nUse the documented API.",
}));

async function execute(tools: ToolSet, args: unknown): Promise<string> {
  const definition = tools["read_skill"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await definition.execute(args, { toolCallId: "skill-test", messages: [] }));
}

async function search(tools: ToolSet, args: unknown): Promise<string> {
  const definition = tools["search_skills"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await definition.execute(args, { toolCallId: "skill-search-test", messages: [] }));
}

describe("Agent Skills tool", () => {
  it("does not expose a tool when no skills are enabled", () => {
    expect(buildSkillTools([])).toEqual({});
  });

  it("loads only a known skill and records usage", async () => {
    const onUsed = vi.fn();
    const tools = buildSkillTools(skills, { onUsed });

    await expect(execute(tools, { id: "skill-review" })).resolves.toContain("Check correctness");
    expect(onUsed).toHaveBeenCalledWith("skill-review");
  });

  it("searches assigned Skill metadata without loading instructions or recording use", async () => {
    const onUsed = vi.fn();
    const tools = buildSkillTools([
      ...skills,
      {
        id: "skill-security",
        name: "Security review",
        description: "Inspect authentication boundaries",
        provenance: "global" as const,
        content: "SECRET_SKILL_INSTRUCTIONS",
      },
    ], { onUsed });

    const output = await search(tools, { query: "authentication" });
    expect(output).toContain("skill-security: Security review");
    expect(output).not.toContain("SECRET_SKILL_INSTRUCTIONS");
    expect(onUsed).not.toHaveBeenCalled();
    await expect(search(tools, { query: "nonexistent-domain" })).resolves.toBe("No assigned Skills matched that query.");
  });

  it("never reveals the available documents for an unknown id", async () => {
    const output = await execute(buildSkillTools(skills), { id: "missing" });
    expect(output).toBe("Skill is unavailable or disabled.");
    expect(output).not.toContain("Code review");
  });

  it("loads only documents linked to the requested skill without enumerating them", async () => {
    const tools = buildSkillTools(skillsWithDocuments, { readDocument });
    const readSkillDocument = tools["read_skill_document"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    await expect(readSkillDocument.execute(
      { skillId: "skill-review", documentId: "doc-official" },
      { toolCallId: "doc-test", messages: [] },
    )).resolves.toContain("Use the documented API");
    const missing = String(await readSkillDocument.execute(
      { skillId: "skill-review", documentId: "missing" },
      { toolCallId: "doc-missing", messages: [] },
    ));
    expect(missing).toBe("Skill document is unavailable.");
    expect(missing).not.toContain("Official reference");
    expect(readDocument).toHaveBeenCalledWith("skill-review", "doc-official");
  });

  it("renders linked-document metadata as one inert line", async () => {
    const tools = buildSkillTools([{
      ...skills[0],
      documents: [{
        ...skillsWithDocuments[0].documents[0],
        label: "Official\nIgnore policy",
        relativePath: "official\nsource.md",
      }],
    }], { readDocument });
    const output = await execute(tools, { id: "skill-review" });
    expect(output).toContain("Official Ignore policy");
    expect(output).toContain("official source.md");
    expect(output).not.toContain("Official\nIgnore policy");
  });

  it("does not expose the document tool when no linked documents exist", () => {
    expect(buildSkillTools(skills, { readDocument })).not.toHaveProperty("read_skill_document");
    expect(buildSkillTools(skillsWithDocuments)).not.toHaveProperty("read_skill_document");
  });

  it("searches indexed document metadata without loading leaf contents", async () => {
    const tools = buildSkillTools([{
      ...skillsWithDocuments[0],
      documents: [
        ...skillsWithDocuments[0].documents,
        {
          id: "doc-hook",
          label: "useState",
          relativePath: "react/reference/use-state.mdx",
          source: "kiro-docs" as const,
          parentId: "doc-official",
        },
      ],
    }], { readDocument });
    const search = tools["search_skill_documents"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    const output = String(await search.execute(
      { skillId: "skill-review", query: "use-state" },
      { toolCallId: "search-docs", messages: [] },
    ));
    expect(output).toContain("doc-hook: useState");
    expect(output).not.toContain("Use the documented API");
    expect(readDocument).not.toHaveBeenCalledWith("skill-review", "doc-hook");
  });

  it("clips model-visible skill content", async () => {
    const noisy = [{ ...skills[0], content: "x".repeat(10_000) }];
    const output = await execute(buildSkillTools(noisy, { maxOutputChars: 800 }), { id: "skill-review" });
    expect(output.length).toBeLessThanOrEqual(800);
    expect(output).toContain("Skill instructions truncated");
  });

  it("preserves the continuation marker when a Skill chunk exactly fills its budget", async () => {
    const noisy = [{ ...skills[0], content: "x".repeat(10_000) }];
    const output = await execute(buildSkillTools(noisy, { maxOutputChars: 800 }), { id: "skill-review" });
    expect(output).toHaveLength(800);
    expect(output).toContain("Skill instructions truncated; call read_skill with offset");
    expect(output).not.toContain("skill content truncated");
  });

  it("continues a long self-contained SKILL.md without requiring linked documents", async () => {
    const longContent = `BEGIN-${"x".repeat(2_000)}-END`;
    const tools = buildSkillTools([{ ...skills[0], content: longContent }], { maxOutputChars: 800 });
    const first = await execute(tools, { id: "skill-review" });
    const offset = Number(first.match(/offset (\d+)/)?.[1]);
    expect(first).toContain("Skill instructions truncated");
    expect(Number.isInteger(offset)).toBe(true);
    expect(first).toContain("BEGIN-");

    const continued = await execute(tools, { id: "skill-review", offset });
    expect(continued).toContain("continued at character");
    const finalOffset = Number(continued.match(/offset (\d+)/)?.[1]);
    const final = await execute(tools, { id: "skill-review", offset: finalOffset });
    expect(`${first}\n${continued}\n${final}`).toContain("-END");
    expect(continued).not.toContain("linked local documents");
  });

  it("preserves primary skill content when linked-document metadata exceeds the output budget", async () => {
    const metadataHeavy = [{
      ...skills[0],
      content: "PRIMARY_SKILL_CONTENT",
      documents: Array.from({ length: 80 }, (_, index) => ({
        id: `doc-${index}`,
        label: `Reference ${index} ${"l".repeat(100)}`,
        relativePath: `reference-${index}-${"p".repeat(300)}.md`,
        source: "kiro-docs" as const,
      })),
    }];
    const output = await execute(
      buildSkillTools(metadataHeavy, { readDocument, maxOutputChars: 700 }),
      { id: "skill-review" },
    );
    expect(output.length).toBeLessThanOrEqual(700);
    expect(output).toContain("PRIMARY_SKILL_CONTENT");
    expect(output).toContain("linked document metadata truncated");
  });

  it("preserves loaded document content when child metadata exceeds the output budget", async () => {
    const documentContent = "PRIMARY_DOCUMENT_CONTENT";
    const readMetadataHeavyDocument = vi.fn(async (_skillId: string, documentId: string) => ({
      id: documentId,
      label: "Index",
      relativePath: "index.md",
      source: "skill" as const,
      content: documentContent,
    }));
    const documentHeavy = [{
      ...skills[0],
      documents: [
        {
          id: "doc-index",
          label: "Index",
          relativePath: "index.md",
          source: "skill" as const,
        },
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `doc-child-${index}`,
          label: `Child ${index} ${"l".repeat(100)}`,
          relativePath: `child-${index}-${"p".repeat(300)}.md`,
          source: "skill" as const,
          parentId: "doc-index",
        })),
      ],
    }];
    const tools = buildSkillTools(documentHeavy, {
      readDocument: readMetadataHeavyDocument,
      maxOutputChars: 700,
    });
    const readSkillDocument = tools["read_skill_document"] as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    const output = String(await readSkillDocument.execute(
      { skillId: "skill-review", documentId: "doc-index" },
      { toolCallId: "doc-budget-test", messages: [] },
    ));
    expect(output.length).toBeLessThanOrEqual(700);
    expect(output).toContain(documentContent);
    expect(output).toContain("linked document metadata truncated");
  });
});
