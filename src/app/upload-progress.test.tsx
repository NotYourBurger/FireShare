import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UploadProgress } from "./upload-form";

const MB = 1_000_000;

describe("upload progress", () => {
  it("shows overall progress and each file's state", () => {
    const html = renderToStaticMarkup(
      <UploadProgress
        progress={[
          { name: "a.exr", size: 100 * MB, sent: 100 * MB, status: "done" },
          { name: "b.exr", size: 100 * MB, sent: 50 * MB, status: "uploading" },
          { name: "c.exr", size: 100 * MB, sent: 25 * MB, status: "retrying" },
          { name: "d.exr", size: 100 * MB, sent: 0, status: "waiting" },
        ]}
      />,
    );
    expect(html).toContain("43% · 175 MB of 400 MB");
    expect(html).toMatch(/data-status="done".*a\.exr.*Done</);
    expect(html).toMatch(/data-status="uploading".*b\.exr.*Uploading · 50%/);
    expect(html).toMatch(/data-status="retrying".*c\.exr.*Retrying… · 25%/);
    expect(html).toMatch(/data-status="waiting".*d\.exr.*Waiting · 0%/);
  });

  it("counts a share of empty files as complete once they're done", () => {
    const html = renderToStaticMarkup(
      <UploadProgress progress={[{ name: "empty.txt", size: 0, sent: 0, status: "done" }]} />,
    );
    expect(html).toContain("100%");
  });
});
