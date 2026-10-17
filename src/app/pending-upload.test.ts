import { describe, expect, it } from "vitest";
import { clearPendingUpload, loadPendingUpload, matchFiles, savePendingUpload, type PendingUpload } from "./pending-upload";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

const pending: PendingUpload = {
  shareId: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f",
  expiry: "7d",
  files: [
    { name: "plate.exr", size: 3, lastModified: 1000, uploadUrl: "http://x/api/uploads/1" },
    { name: "notes.txt", size: 2, lastModified: 2000, uploadUrl: "http://x/api/uploads/2" },
  ],
};

describe("pending upload", () => {
  it("is remembered until cleared", () => {
    const store = memoryStore();
    expect(loadPendingUpload(store)).toBeNull();
    savePendingUpload(pending, store);
    expect(loadPendingUpload(store)).toEqual(pending);
    clearPendingUpload(store);
    expect(loadPendingUpload(store)).toBeNull();
  });

  it("ignores stored values that aren't a pending upload", () => {
    const store = memoryStore();
    const invalid = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...pending, files: [] }),
      JSON.stringify({ ...pending, files: [{ name: "a" }] }),
    ];
    for (const value of invalid) {
      store.items.set("fireshare.pendingUpload", value);
      expect(loadPendingUpload(store)).toBeNull();
    }
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
      expect(() => savePendingUpload(pending, store)).not.toThrow();
      expect(loadPendingUpload(store)).toBeNull();
      expect(() => clearPendingUpload(store)).not.toThrow();
    }
  });

  it("matches reselected files by name, size and modification time", () => {
    const plate = new File(["abc"], "plate.exr", { lastModified: 1000 });
    const changedNotes = new File(["hi"], "notes.txt", { lastModified: 2500 });
    const other = new File(["abc"], "other.exr", { lastModified: 1000 });
    expect(matchFiles(pending, [other, changedNotes, plate])).toEqual([plate, undefined]);
  });
});
