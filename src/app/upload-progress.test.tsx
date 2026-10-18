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
    expect(html).toContain('aria-valuenow="43"');
    expect(html).toContain("175 MB of 400 MB");
    // The file in flight is described beside the dial.
    expect(html).toContain("<strong>b.exr</strong><span>Uploading · 50%, file 2 of 4</span>");
    expect(html).toMatch(/data-status="done".*a\.exr.*Done</);
    expect(html).toMatch(/data-status="uploading".*b\.exr.*Uploading · 50%/);
    expect(html).toMatch(/data-status="retrying".*c\.exr.*Retrying… · 25%/);
    expect(html).toMatch(/data-status="waiting".*d\.exr.*Waiting · 0%/);
  });

  it("counts a share of empty files as complete once they're done", () => {
    const html = renderToStaticMarkup(
      <UploadProgress progress={[{ name: "empty.txt", size: 0, sent: 0, status: "done" }]} />,
    );
    expect(html).toContain('aria-valuenow="100"');
  });

  it("pads indices to 3 digits when uploading 100 files", () => {
    const progress = Array.from({ length: 100 }, (_, i) => ({
      name: `frame_${String(i + 1).padStart(4, "0")}.png`,
      size: MB,
      sent: i < 50 ? MB : 0,
      status: (i < 50 ? "done" : i === 50 ? "uploading" : "waiting") as "done" | "uploading" | "waiting",
    }));
    const html = renderToStaticMarkup(<UploadProgress progress={progress} />);
    expect(html).toContain('<span class="row-index" aria-hidden="true">001</span>');
    expect(html).toContain('<span class="row-index" aria-hidden="true">100</span>');
    expect(html).toContain("file 51 of 100");
  });
});
