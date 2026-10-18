import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuoteCache, EDITORIAL_BACKDROPS, fetchRandomQuote, pickRandomBackdrop } from "./quote";

describe("ZenQuotes integration and editorial backdrops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a random quote per request from zenquotes.io", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ q: "Simplicity is the ultimate sophistication.", a: "Leonardo da Vinci" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchRandomQuote();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://zenquotes.io/api/random",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(result).toEqual({
      quote: "Simplicity is the ultimate sophistication.",
      author: "Leonardo da Vinci",
    });
  });

  it("falls back to a curated quote when the network or API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await fetchRandomQuote();
    expect(result.quote.length).toBeGreaterThan(0);
    expect(result.author.length).toBeGreaterThan(0);
  });

  it("answers from the cache at once and refreshes it at most once per interval", async () => {
    let time = 0;
    const live = { quote: "Fetched in the background.", author: "ZenQuotes" };
    const fetchQuote = vi.fn().mockResolvedValue(live);
    const cache = createQuoteCache({ fetchQuote, refreshMs: 60_000, now: () => time });

    // Nothing fetched yet: a curated quote, and one background fetch starts.
    expect(cache.quote()).not.toEqual(live);
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    await Promise.resolve();

    expect(cache.quote()).toEqual(live);
    time += 59_999;
    cache.quote();
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    time += 1;
    cache.quote();
    expect(fetchQuote).toHaveBeenCalledTimes(2);
  });

  it("keeps serving curated quotes while fetches fail", async () => {
    let time = 0;
    const fetchQuote = vi.fn().mockResolvedValue(null).mockRejectedValueOnce(new Error("offline"));
    const cache = createQuoteCache({ fetchQuote, refreshMs: 1, now: () => time++ });
    for (let i = 0; i < 3; i++) {
      const quote = cache.quote();
      expect(quote.quote.length).toBeGreaterThan(0);
      await Promise.resolve();
    }
  });

  it("picks a valid editorial backdrop", () => {
    const backdrop = pickRandomBackdrop();
    expect(EDITORIAL_BACKDROPS).toContainEqual(backdrop);
    expect(backdrop.photoUrl).toMatch(/^https:\/\//);
    expect(backdrop.colors).toHaveLength(3);
  });
});
