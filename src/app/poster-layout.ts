/**
 * Sets a quote as a poster: breaks it into lines and sizes each line so it
 * runs the full width of the column. Works for any length of quote by trying
 * every line count and keeping the one that best fills the space.
 */

export interface PosterLine {
  text: string;
  /** Font size in px. */
  size: number;
  /** "fill" lines run the full width; capped lines sit at one side or the other. */
  align: "fill" | "start" | "end";
}

export interface PosterLayoutInput {
  text: string;
  /** Width of a string set at 100px in the display face. */
  measure: (text: string) => number;
  width: number;
  maxHeight: number;
  /** Line height as a fraction of font size. */
  leading?: number;
}

/** Words a line shouldn't end on, as in good book typesetting. */
const WEAK_ENDINGS = new Set(["A", "AN", "THE", "OF", "TO", "IN", "AND", "OR", "BUT", "IS", "ON", "AT", "FOR", "BY"]);
const MAX_LINES = 10;
/** How much larger than the median line any one line may grow. */
const MAX_SCALE = 1.5;
/** The largest share of the block one line may take, so one-word lines can't swamp it. */
const MAX_LINE_SHARE = 0.42;

export function layoutPoster({ text, measure, width, maxHeight, leading = 0.92 }: PosterLayoutInput): PosterLine[] {
  const words = text.toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || width <= 0 || maxHeight <= 0) return [];

  const widths = words.map(measure);
  const space = Math.max(0, measure("A A") - measure("AA"));

  let best: { lines: PosterLine[]; height: number } | null = null;
  let smallest: { lines: PosterLine[]; height: number } | null = null;

  for (let count = 1; count <= Math.min(words.length, MAX_LINES); count++) {
    const breaks = breakLines(words, widths, space, count);
    const lines = sizeLines(breaks, words, widths, space, width, maxHeight);
    const height = lines.reduce((sum, line) => sum + line.size * leading, 0);
    if (height <= maxHeight && (!best || height > best.height)) best = { lines, height };
    if (!smallest || height < smallest.height) smallest = { lines, height };
  }

  if (best) return best.lines;
  // Nothing fits the height: shrink the flattest layout until it does.
  const scale = maxHeight / smallest!.height;
  return smallest!.lines.map((line) => ({
    ...line,
    size: round(line.size * scale),
    align: line.align === "fill" ? "start" : line.align,
  }));
}

/** Splits words into `count` lines of as even a width as possible. Returns each line's [start, end). */
function breakLines(words: string[], widths: number[], space: number, count: number): [number, number][] {
  const n = words.length;
  const prefix = [0];
  for (const w of widths) prefix.push(prefix[prefix.length - 1] + w);
  const lineWidth = (i: number, j: number) => prefix[j] - prefix[i] + (j - i - 1) * space;
  const target = lineWidth(0, n) / count;

  const cost = (i: number, j: number) => {
    let c = ((lineWidth(i, j) - target) / target) ** 2;
    // A lone short word would be set enormous.
    if (j - i === 1 && words[i].length <= 3 && count > 1) c += 0.6;
    if (j < n && WEAK_ENDINGS.has(words[j - 1].replace(/[^A-Z]/g, ""))) c += 0.2;
    return c;
  };

  // dp[l][j]: cheapest way to set the first j words in l lines.
  const dp = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(0));
  dp[0][0] = 0;
  for (let l = 1; l <= count; l++) {
    for (let j = l; j <= n; j++) {
      for (let i = l - 1; i < j; i++) {
        const c = dp[l - 1][i] + cost(i, j);
        if (c < dp[l][j]) {
          dp[l][j] = c;
          from[l][j] = i;
        }
      }
    }
  }

  const breaks: [number, number][] = [];
  for (let l = count, j = n; l > 0; l--) {
    const i = from[l][j];
    breaks.unshift([i, j]);
    j = i;
  }
  return breaks;
}

function sizeLines(
  breaks: [number, number][],
  words: string[],
  widths: number[],
  space: number,
  width: number,
  maxHeight: number,
): PosterLine[] {
  const fitted = breaks.map(([i, j]) => {
    const natural = widths.slice(i, j).reduce((a, b) => a + b, 0) + (j - i - 1) * space;
    return { text: words.slice(i, j).join(" "), size: (width / natural) * 100 };
  });
  const sorted = fitted.map((line) => line.size).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cap = Math.min(median * MAX_SCALE, maxHeight * MAX_LINE_SHARE);

  let side = 0;
  return fitted.map((line) => {
    if (line.size <= cap) return { text: line.text, size: round(line.size), align: "fill" as const };
    // Capped lines alternate sides, so the block keeps its rhythm.
    const align = side++ % 2 === 0 ? ("start" as const) : ("end" as const);
    return { text: line.text, size: round(cap), align };
  });
}

/** Rounds down a little, so rounding never pushes a line past the column. */
function round(size: number): number {
  return Math.floor(size * 0.995 * 100) / 100;
}
