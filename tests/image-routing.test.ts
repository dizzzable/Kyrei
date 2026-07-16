import { describe, it, expect } from "vitest";
import {
  coerceImageInputMode,
  decideImagePresentation,
  modelSupportsImageInput,
} from "../core/engine/images/image-routing.js";
import {
  normalizePromptImages,
  buildUserMessageContent,
  MAX_PROMPT_IMAGES,
} from "../core/image-attachments.js";

describe("image routing (Hermes image_input_mode)", () => {
  it("coerces modes", () => {
    expect(coerceImageInputMode("native")).toBe("native");
    expect(coerceImageInputMode("TEXT")).toBe("text");
    expect(coerceImageInputMode("nope")).toBe("auto");
  });

  it("auto picks native when model supports vision", () => {
    expect(decideImagePresentation("auto", true)).toBe("native");
    expect(decideImagePresentation("auto", false)).toBe("text");
    expect(decideImagePresentation("native", false)).toBe("native");
    expect(decideImagePresentation("text", true)).toBe("text");
  });

  it("detects vision capability shapes", () => {
    expect(modelSupportsImageInput({ supportsVision: true })).toBe(true);
    expect(modelSupportsImageInput({ modalities: { input: ["text", "image"] } })).toBe(true);
    expect(modelSupportsImageInput({ capabilities: { inputModalities: ["image"] } })).toBe(true);
    expect(modelSupportsImageInput({ id: "gpt-text" })).toBe(false);
  });
});

describe("prompt images normalize", () => {
  it("accepts valid base64 png", () => {
    // 1x1 png
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { images, errors } = normalizePromptImages([
      { name: "dot.png", mediaType: "image/png", data: png.toString("base64") },
    ]);
    expect(errors).toEqual([]);
    expect(images).toHaveLength(1);
    expect(images[0]!.mediaType).toBe("image/png");
  });

  it("rejects too many images", () => {
    const { images, errors } = normalizePromptImages(
      Array.from({ length: MAX_PROMPT_IMAGES + 1 }, () => ({
        mediaType: "image/png",
        data: "aa",
      })),
    );
    expect(images).toHaveLength(0);
    expect(errors).toContain("images_too_many");
  });

  it("builds text presentation without pixels", async () => {
    const content = await buildUserMessageContent(
      "look",
      [{ id: "1", name: "a.png", mediaType: "image/png", relPath: "s/a.png", bytes: 12 }],
      "text",
      "/tmp",
    );
    expect(typeof content).toBe("string");
    expect(String(content)).toContain("a.png");
    expect(String(content)).toContain("text mode");
  });
});
