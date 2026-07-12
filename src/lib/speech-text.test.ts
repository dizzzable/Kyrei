import { describe, it, expect } from "vitest";
import { sanitizeTextForSpeech } from "@/lib/speech-text";

describe("sanitizeTextForSpeech", () => {
  it("removes fenced code blocks", () => {
    const input = "Before\n```ts\nconst x = 1;\n```\nAfter";
    expect(sanitizeTextForSpeech(input)).toBe("Before After");
  });

  it("unwraps inline code", () => {
    expect(sanitizeTextForSpeech("Call `foo()` now")).toBe("Call foo() now");
  });

  it("replaces urls with the word link", () => {
    expect(sanitizeTextForSpeech("See https://example.com/x for more")).toBe(
      "See link for more"
    );
  });

  it("keeps markdown link text and drops the target", () => {
    expect(sanitizeTextForSpeech("Read [the docs](https://example.com)")).toBe(
      "Read the docs"
    );
  });

  it("strips emoji", () => {
    expect(sanitizeTextForSpeech("Nice work 🎉 done")).toBe("Nice work done");
  });

  it("strips markdown heading and emphasis markers", () => {
    expect(sanitizeTextForSpeech("# Title\n**bold** and _italic_")).toBe(
      "Title bold and italic"
    );
  });

  it("removes list bullet markers", () => {
    expect(sanitizeTextForSpeech("- one\n- two")).toBe("one - two");
  });

  it("collapses runs of whitespace", () => {
    expect(sanitizeTextForSpeech("a    b\t\tc")).toBe("a b c");
  });

  it("collapses paragraph breaks into a sentence separator", () => {
    expect(sanitizeTextForSpeech("First para\n\nSecond para")).toBe(
      "First para. Second para"
    );
  });

  it("strips a thinking prefix", () => {
    expect(sanitizeTextForSpeech("Thinking... here is the answer")).toBe(
      "here is the answer"
    );
  });
});
