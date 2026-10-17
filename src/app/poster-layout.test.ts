import { describe, expect, it } from "vitest";
import { layoutPoster } from "./poster-layout";

// A monospaced stand-in for the display face: every character 42px wide at 100px.
const measure = (text: string) => text.length * 42;
const width = 800;

describe("layoutPoster", () => {
  it("keeps every word, in order, in capitals", () => {
    const text = "In the blur of life, find your focus.";
    const lines = layoutPoster({ text, measure, width, maxHeight: 560 });
    expect(lines.map((line) => line.text).join(" ")).toBe(text.toUpperCase());
  });

  it("never sets a line wider than the column", () => {
    const text =
      "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.";
    for (const line of layoutPoster({ text, measure, width, maxHeight: 560 })) {
      expect(measure(line.text) * (line.size / 100)).toBeLessThanOrEqual(width);
    }
  });

  it("fits the block inside the height it is given", () => {
    for (const text of ["Less.", "Less, but better.", "To attain knowledge, add things every day. To attain wisdom, remove things every day."]) {
      const lines = layoutPoster({ text, measure, width, maxHeight: 400 });
      const height = lines.reduce((sum, line) => sum + line.size * 0.92, 0);
      expect(height).toBeLessThanOrEqual(400);
    }
  });

  it("uses more lines for longer quotes", () => {
    const short = layoutPoster({ text: "Less, but better.", measure, width, maxHeight: 560 });
    const long = layoutPoster({
      text: "To attain knowledge, add things every day. To attain wisdom, remove things every day.",
      measure,
      width,
      maxHeight: 560,
    });
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("does not end a line on a weak word when it can avoid it", () => {
    const lines = layoutPoster({
      text: "Simplicity is about subtracting the obvious and adding the meaningful.",
      measure,
      width,
      maxHeight: 560,
    });
    for (const line of lines.slice(0, -1)) {
      expect(line.text.split(" ").at(-1)).not.toMatch(/^(THE|AND|A|OF|TO)$/);
    }
  });

  it("caps an oversized line and moves it to one side", () => {
    const lines = layoutPoster({ text: "Go and see the extraordinary unbelievable world", measure, width, maxHeight: 2000 });
    const median = [...lines].sort((a, b) => a.size - b.size)[Math.floor(lines.length / 2)].size;
    for (const line of lines) {
      expect(line.size).toBeLessThanOrEqual(median * 1.5 + 0.01);
      if (line.align !== "fill") expect(measure(line.text) * (line.size / 100)).toBeLessThan(width);
    }
  });

  it("returns nothing for an empty quote or no space", () => {
    expect(layoutPoster({ text: "  ", measure, width, maxHeight: 400 })).toEqual([]);
    expect(layoutPoster({ text: "Hello", measure, width: 0, maxHeight: 400 })).toEqual([]);
  });
});
