export interface Quote {
  quote: string;
  author: string;
}

export interface EditorialBackdrop {
  id: string;
  label: string;
  series: string;
  caption: string;
  /** Bundled photograph, served by the app (see public/backdrops/CREDITS.md). */
  localPhotoUrl: string;
  /** Dynamic 3-stop aurora gradient palette synced to this visual study. */
  colors: [string, string, string];
  /** CSS gradient fallback if offline or while loading. */
  fallbackGradient: string;
}

const FALLBACK_QUOTES: Quote[] = [
  {
    quote: "Life is really simple, but we insist on making it complicated.",
    author: "Confucius",
  },
  {
    quote: "In the blur of life, find your focus.",
    author: "Ion Lucin",
  },
  {
    quote: "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.",
    author: "Antoine de Saint-Exupéry",
  },
  {
    quote: "Less, but better — because it concentrates on the essential aspects.",
    author: "Dieter Rams",
  },
  {
    quote: "Simplicity is about subtracting the obvious and adding the meaningful.",
    author: "John Maeda",
  },
  {
    quote: "To attain knowledge, add things every day. To attain wisdom, remove things every day.",
    author: "Lao Tzu",
  },
];

export const EDITORIAL_BACKDROPS: EditorialBackdrop[] = [
  {
    id: "01",
    label: "Stillness",
    series: "STUDY 01 · ARCHITECTURAL SILENCE",
    caption: "By reducing noise, attention shifts toward space, form, and kinetic intention.",
    localPhotoUrl: "/backdrops/1323550-1800.jpg",
    colors: ["#ff5a1f", "#e79aae", "#6b8cce"],
    fallbackGradient:
      "radial-gradient(circle at 50% 80%, rgba(232, 78, 27, 0.35), transparent 60%), linear-gradient(160deg, #1f1e1c 0%, #121110 55%, #2b1d17 100%)",
  },
  {
    id: "02",
    label: "Horizon",
    series: "STUDY 02 · ATMOSPHERIC DEPTH",
    caption: "In a moving world of light and blur, clarity emerges from motion.",
    localPhotoUrl: "/backdrops/2014422-1800.jpg",
    colors: ["#f58549", "#5c9ead", "#d49a72"],
    fallbackGradient:
      "radial-gradient(circle at 30% 75%, rgba(217, 72, 15, 0.32), transparent 65%), linear-gradient(145deg, #1c2226 0%, #121314 60%, #261c18 100%)",
  },
  {
    id: "03",
    label: "Refraction",
    series: "STUDY 03 · OPTICAL GLASS",
    caption: "Space becomes an active living medium rather than a static background.",
    localPhotoUrl: "/backdrops/1287145-1800.jpg",
    colors: ["#e84e1b", "#9b7ede", "#68b0ab"],
    fallbackGradient:
      "radial-gradient(circle at 65% 85%, rgba(255, 89, 36, 0.35), transparent 60%), linear-gradient(170deg, #252320 0%, #141311 65%, #2d1b14 100%)",
  },
  {
    id: "04",
    label: "Velocity",
    series: "STUDY 04 · VISUAL RESTRAINT",
    caption: "With fewer components present, tension between scale and motion becomes clear.",
    localPhotoUrl: "/backdrops/2559941-1800.jpg",
    colors: ["#ff6b2c", "#c45baa", "#4ea8de"],
    fallbackGradient:
      "radial-gradient(circle at 45% 80%, rgba(224, 79, 26, 0.32), transparent 58%), linear-gradient(155deg, #21201e 0%, #10100f 60%, #291a14 100%)",
  },
  {
    id: "05",
    label: "Aurora",
    series: "STUDY 05 · SHADOW & GRAIN",
    caption: "Every transfer is guided by velocity, balance, and quiet impermanence.",
    localPhotoUrl: "/backdrops/3408744-1800.jpg",
    colors: ["#38d399", "#4f7cac", "#ff5a1f"],
    fallbackGradient:
      "radial-gradient(circle at 50% 85%, rgba(255, 107, 44, 0.34), transparent 62%), linear-gradient(165deg, #1a1b1d 0%, #0f0f10 60%, #241813 100%)",
  },
];

export function pickRandomBackdrop(): EditorialBackdrop {
  const index = Math.floor(Math.random() * EDITORIAL_BACKDROPS.length);
  return EDITORIAL_BACKDROPS[index];
}

export function pickFallbackQuote(): Quote {
  const index = Math.floor(Math.random() * FALLBACK_QUOTES.length);
  return FALLBACK_QUOTES[index];
}

/**
 * Fetches a random quote from https://zenquotes.io/api/random with a timeout,
 * or null when the network or API fails or the API is rate limiting us.
 */
export async function fetchLiveQuote(): Promise<Quote | null> {
  try {
    const res = await fetch("https://zenquotes.io/api/random", {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      const entry = data[0] as Record<string, unknown>;
      const q = typeof entry.q === "string" ? entry.q.trim() : "";
      const a = typeof entry.a === "string" ? entry.a.trim() : "";
      if (q && !q.toLowerCase().includes("too many requests")) {
        return { quote: q, author: a || "Unknown" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetches a random quote from zenquotes.io, falling back to a curated one. */
export async function fetchRandomQuote(): Promise<Quote> {
  return (await fetchLiveQuote()) ?? pickFallbackQuote();
}

/**
 * Quotes for page renders and /api/quote without waiting on the network: it
 * answers at once from a pool of recently fetched quotes (curated ones until
 * the first fetch lands), and refreshes the pool in the background at most
 * once per `refreshMs`. ZenQuotes allows only a few requests per IP every 30s.
 */
export function createQuoteCache({
  fetchQuote = fetchLiveQuote,
  refreshMs = 60_000,
  poolSize = 20,
  now = Date.now,
}: {
  fetchQuote?: () => Promise<Quote | null>;
  refreshMs?: number;
  poolSize?: number;
  now?: () => number;
} = {}) {
  const pool: Quote[] = [];
  let lastRefresh = -Infinity;

  function refresh() {
    if (now() - lastRefresh < refreshMs) return;
    lastRefresh = now();
    void fetchQuote()
      .then((quote) => {
        if (!quote || pool.some((q) => q.quote === quote.quote)) return;
        pool.push(quote);
        if (pool.length > poolSize) pool.shift();
      })
      .catch(() => {});
  }

  return {
    quote(): Quote {
      refresh();
      return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : pickFallbackQuote();
    },
  };
}

