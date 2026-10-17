import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShareExpired, ShareView } from "./share-view";

const token = "AAAAAAAAAAAAAAAAAAAAAA";
const fileId = "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f";

function render(share: Parameters<typeof ShareView>[0]["share"]) {
  return renderToStaticMarkup(<ShareView token={token} share={share} />);
}

describe("recipient page", () => {
  it("renders the sender's title and message as text, never as markup", () => {
    const html = render({
      title: "<script>alert(1)</script>",
      message: '<img src=x onerror="alert(1)">\nsecond line',
      files: [{ id: fileId, name: "a.txt", size: 1 }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;\nsecond line");
  });

  it("lists every file with its size and its own download link", () => {
    const html = render({
      title: null,
      message: null,
      files: [
        { id: fileId, name: "../../etc/passwd", size: 1_500_000 },
        { id: "0e9d8c7b-6a5f-4e4d-8c3b-2a1d0c9b8a7f", name: "日本語 <b>.txt", size: 999 },
      ],
    });
    expect(html).toContain("Shared files");
    expect(html).toContain("2 files · 1.5 MB");
    expect(html).toContain("../../etc/passwd");
    expect(html).toContain("1.5 MB");
    expect(html).toContain("日本語 &lt;b&gt;.txt");
    expect(html).toContain("999 bytes");
    expect(html).toContain(`href="/d/${token}/files/${fileId}"`);
    expect(html.match(/>Download</g)).toHaveLength(2);
  });

  it("tells the recipient an expired link's files are gone, without listing them", () => {
    const html = renderToStaticMarkup(<ShareExpired />);
    expect(html).toContain("This link has expired");
    expect(html).not.toContain("Download");
  });
});
