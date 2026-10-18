import { describe, expect, it, vi } from "vitest";

const constructed: Record<string, unknown>[] = [];

vi.mock("tus-js-client", () => ({
  Upload: class {
    constructor(_file: Blob, options: Record<string, unknown>) {
      constructed.push(options);
    }
    start() {}
    abort() {}
  },
}));

const { uploadFile } = await import("./chunked-upload");

describe("uploadFile defaults", () => {
  it("leaves tus's own http stack in place when none is given", () => {
    void uploadFile(new Blob(["x"]), "http://localhost/api/uploads/1", { chunkSize: 1 });
    // tus spreads options over its defaults, so even `httpStack: undefined` would replace the browser's stack.
    expect(constructed[0]).not.toHaveProperty("httpStack");
  });
});
