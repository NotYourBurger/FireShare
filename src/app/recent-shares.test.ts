import { describe, expect, it } from "vitest";
import { addRecentShare, loadRecentShares, managementToken, removeRecentShare, type RecentShare } from "./recent-shares";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

const entry = (n: number): RecentShare => ({
  url: `http://x/d/share${n}`,
  manageUrl: `http://x/m/manage${n}`,
  title: n === 1 ? null : `Share ${n}`,
  expiresAt: "2026-01-08T00:00:00.000Z",
});

describe("recent shares", () => {
  it("lists shares newest first until removed", () => {
    const store = memoryStore();
    expect(loadRecentShares(store)).toEqual([]);
    addRecentShare(entry(1), store);
    addRecentShare(entry(2), store);
    expect(loadRecentShares(store)).toEqual([entry(2), entry(1)]);
    removeRecentShare(entry(2).manageUrl, store);
    expect(loadRecentShares(store)).toEqual([entry(1)]);
  });

  it("lists a share only once", () => {
    const store = memoryStore();
    addRecentShare(entry(1), store);
    addRecentShare(entry(2), store);
    addRecentShare(entry(1), store);
    expect(loadRecentShares(store)).toEqual([entry(1), entry(2)]);
  });

  it("forgets the oldest shares beyond 100", () => {
    const store = memoryStore();
    for (let n = 1; n <= 101; n++) addRecentShare(entry(n), store);
    const listed = loadRecentShares(store);
    expect(listed).toHaveLength(100);
    expect(listed[0]).toEqual(entry(101));
    expect(listed.at(-1)).toEqual(entry(2));
  });

  it("skips stored values that aren't recent shares", () => {
    const store = memoryStore();
    for (const value of ["not json", "null", "{}"]) {
      store.items.set("fireshare.recentShares", value);
      expect(loadRecentShares(store)).toEqual([]);
    }
    store.items.set(
      "fireshare.recentShares",
      JSON.stringify([{ url: "x" }, { ...entry(1), manageUrl: "not a url" }, { ...entry(1), expiresAt: "soon" }, entry(2)]),
    );
    expect(loadRecentShares(store)).toEqual([entry(2)]);
  });

  it("works without storage, and when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    for (const store of [null, throwing]) {
      expect(() => addRecentShare(entry(1), store)).not.toThrow();
      expect(loadRecentShares(store)).toEqual([]);
      expect(() => removeRecentShare(entry(1).manageUrl, store)).not.toThrow();
    }
  });

  it("finds the management token in a management link", () => {
    expect(managementToken("https://share.example.com/m/AAAAAAAAAAAAAAAAAAAAAA")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  });
});
