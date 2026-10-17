import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManageView, type ManagedShareData } from "./manage-view";

const token = "AAAAAAAAAAAAAAAAAAAAAA";

const share = (fields: Partial<ManagedShareData> = {}): ManagedShareData => ({
  status: "active",
  title: "Shot 12",
  message: null,
  expiresAt: "2026-01-08T09:30:00.000Z",
  deletedAt: null,
  files: [
    { id: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f", name: "plate.exr", size: 1_500_000 },
    { id: "0e9d8c7b-6a5f-4e4d-8c3b-2a1d0c9b8a7f", name: "notes.txt", size: 999 },
  ],
  ...fields,
});

const render = (data: ManagedShareData) => renderToStaticMarkup(<ManageView token={token} share={data} />);

describe("management page", () => {
  it("shows an active share's title, status, expiry and files, with Delete now", () => {
    const html = render(share());
    expect(html).toContain("Shot 12");
    expect(html).toContain("Active");
    expect(html).toContain('Expires <time dateTime="2026-01-08T09:30:00.000Z">8 Jan 2026, 09:30 UTC</time>');
    expect(html).toContain("plate.exr");
    expect(html).toContain("notes.txt");
    expect(html).toContain("999 bytes");
    expect(html).toContain("2 files · 1.5 MB");
    expect(html).toContain("Delete now");
    // The management page never reveals a way to download.
    expect(html).not.toContain("/d/");
  });

  it("shows an expired share as expired, without Delete now", () => {
    const html = render(share({ status: "expired" }));
    expect(html).toContain("Expired <time");
    expect(html).toContain("The share link no longer works");
    expect(html).not.toContain("Delete now");
  });

  it("shows a deleted share as deleted, with when", () => {
    const html = render(share({ status: "deleted", deletedAt: "2026-01-02T10:00:00.000Z" }));
    expect(html).toContain("Deleted <time");
    expect(html).toContain("2 Jan 2026, 10:00 UTC");
    expect(html).not.toContain("Delete now");
  });

  it("renders the sender's title, message and file names as text, never as markup", () => {
    const html = render(
      share({ title: "<script>x</script>", message: "<img src=x>", files: [{ id: "1", name: "<b>.txt", size: 1 }] }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
