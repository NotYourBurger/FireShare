import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecentShare } from "@/app/recent-shares";
import { RecentSharesView, type EntryStatus } from "./recent-shares-list";

const entry = (n: number, title: string | null = `Share ${n}`): RecentShare => ({
  url: `http://x/d/share${n}`,
  manageUrl: `http://x/m/manage${n}`,
  title,
  expiresAt: "2099-01-08T00:00:00.000Z",
});

const render = (entries: RecentShare[], statuses: Record<string, EntryStatus> = {}) =>
  renderToStaticMarkup(<RecentSharesView entries={entries} statuses={statuses} onRemove={() => {}} />);

describe("recent shares page", () => {
  it("explains the empty list, including private windows", () => {
    expect(render([])).toContain("private windows");
  });

  it("shows each share's status, with its share link to open or copy only while active", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4, null)];
    const html = render(entries, {
      "http://x/m/manage1": "active",
      "http://x/m/manage2": "expired",
      "http://x/m/manage3": "deleted",
      "http://x/m/manage4": "gone",
    });
    expect(html).toContain("Active · expires");
    expect(html).toContain("Expired");
    expect(html).toContain("Deleted");
    expect(html).toContain("No longer available");
    expect(html).toContain("Shared files");
    expect(html).toContain('href="http://x/d/share1"');
    expect(html).toContain('aria-label="Copy share link for Share 1"');
    expect(html.match(/>Copy link</g)).toHaveLength(1);
    for (const n of [2, 3, 4]) expect(html).not.toContain(`http://x/d/share${n}`);
    // Every entry can be managed and removed, except a share the server no longer knows.
    for (const n of [1, 2, 3]) expect(html).toContain(`href="http://x/m/manage${n}"`);
    expect(html).not.toContain('href="http://x/m/manage4"');
    expect(html.match(/aria-label="Remove [^"]+ from this list"/g)).toHaveLength(4);
  });

  it("goes by the remembered expiry until the server answers", () => {
    const past = { ...entry(1), expiresAt: "2020-01-01T00:00:00.000Z" };
    expect(render([past])).toContain("Expired <time");
    expect(render([entry(2)])).toContain("Expires <time");
  });
});
