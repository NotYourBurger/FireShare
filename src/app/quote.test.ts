import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITORIAL_BACKDROPS, fetchRandomQuote, pickRandomBackdrop } from "./quote";

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

  it("picks a valid editorial backdrop", () => {
    const backdrop = pickRandomBackdrop();
    expect(EDITORIAL_BACKDROPS).toContainEqual(backdrop);
    expect(backdrop.photoUrl).toMatch(/^https:\/\//);
    expect(backdrop.colors).toHaveLength(3);
  });
});
