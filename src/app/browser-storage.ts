export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where it's blocked (private windows, disabled site data). */
export function browserStorage(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
