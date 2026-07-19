import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const close = vi.fn();
const createStores = vi.fn((baseDir: string) => {
  mkdirSync(baseDir, { recursive: true });
  return { backend: "file" as const, close };
});

vi.mock("../data/index.js", () => ({ createStores }));

const { initializeBuiltinGBrainStore, inspectBuiltinGBrainStore } = await import("./gbrain.js");

describe("built-in Kyrei Memory file fallback", () => {
  let dataDir = "";

  afterEach(async () => {
    close.mockClear();
    createStores.mockClear();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = "";
  });

  it("materializes the empty durable document store during explicit provision", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-memory-file-fallback-"));

    await initializeBuiltinGBrainStore(dataDir);

    expect(createStores).toHaveBeenCalledWith(join(dataDir, "brain"));
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(join(dataDir, "brain", "memory-docs.json"), "utf8")).toBe("[]\n");
    expect(inspectBuiltinGBrainStore(dataDir).initialized).toBe(true);
  });
});
