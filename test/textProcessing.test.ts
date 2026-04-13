import { describe, expect, it } from "vitest";

import {
  buildHighlightSegments,
  collapseWhitespace,
  estimateSegmentEndTimes,
  stripMarkdownForSpeech
} from "../src/textProcessing";

describe("textProcessing", () => {
  it("strips common markdown syntax for speech", () => {
    const source = [
      "# Heading",
      "",
      "- [Docs](https://example.com) with `code` and **bold** text.",
      "",
      "> quoted line",
      "",
      "```ts",
      "const hidden = true;",
      "```"
    ].join("\n");

    expect(stripMarkdownForSpeech(source)).toBe("Heading Docs with code and bold text. quoted line");
  });

  it("collapses whitespace without losing sentence spacing", () => {
    expect(collapseWhitespace("alpha   beta \n\n gamma")).toBe("alpha beta gamma");
  });

  it("splits long prose into multiple highlight segments", () => {
    const source = [
      "First sentence is deliberately long so the paragraph keeps growing with enough words to force a split.",
      "Second sentence keeps the rhythm going and adds enough text to cross the threshold cleanly.",
      "Third sentence finishes the paragraph and should still be represented."
    ].join(" ");

    const segments = buildHighlightSegments(source);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.rawText)).toEqual([
      expect.stringContaining("First sentence"),
      expect.stringContaining("Second sentence"),
      expect.stringContaining("Third sentence")
    ]);
  });

  it("estimates segment end times proportionally", () => {
    const endTimes = estimateSegmentEndTimes([
      { rawStart: 0, rawEnd: 5, rawText: "short", spokenWeight: 10 },
      { rawStart: 6, rawEnd: 16, rawText: "much longer", spokenWeight: 30 }
    ], 4);

    expect(endTimes[0]).toBeCloseTo(1, 5);
    expect(endTimes[1]).toBeCloseTo(4, 5);
  });

  it("handles markdown tables, ordered lists, and zero-duration estimates safely", () => {
    const source = [
      "1. First item",
      "2. Second item",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Voice | af_sky |"
    ].join("\n");

    expect(stripMarkdownForSpeech(source)).toBe("First item Second item Name Value --- --- Voice af_sky");

    const endTimes = estimateSegmentEndTimes([
      { rawStart: 0, rawEnd: 4, rawText: "tiny", spokenWeight: 1 }
    ], 0);

    expect(endTimes[0]).toBeCloseTo(0.01, 5);
  });
});
