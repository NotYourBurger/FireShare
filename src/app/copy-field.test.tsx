import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton, CopyField, copyToClipboard, LinkSlab } from "./copy-field";

describe("copy field and clipboard helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders LinkSlab, CopyField, and CopyButton with type=button", () => {
    const slabHtml = renderToStaticMarkup(<LinkSlab value="http://fireshare.lan:3000/d/abc123" />);
    expect(slabHtml).toContain("fireshare.lan:3000");
    expect(slabHtml).toContain("/d/abc123");
    expect(slabHtml).toContain('type="button"');
    expect(slabHtml).toContain("Copy link");

    const fieldHtml = renderToStaticMarkup(<CopyField value="http://fireshare.lan:3000/m/xyz" label="Management link" />);
    expect(fieldHtml).toContain('type="button"');
    expect(fieldHtml).toContain('aria-label="Copy management link"');

    const btnHtml = renderToStaticMarkup(
      <CopyButton value="http://fireshare.lan:3000/d/abc123" label="Copy share link">
        Copy link
      </CopyButton>,
    );
    expect(btnHtml).toContain('type="button"');
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const ok = await copyToClipboard("http://fireshare.lan:3000/d/token123");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("http://fireshare.lan:3000/d/token123");
  });

  it("falls back to textarea + document.execCommand('copy') when navigator.clipboard is undefined (HTTP context)", async () => {
    vi.stubGlobal("navigator", {});

    let copiedValue = "";
    let removed = false;
    const fakeTextarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    const prevFocus = vi.fn();

    vi.stubGlobal("document", {
      activeElement: { focus: prevFocus },
      createElement: vi.fn(() => fakeTextarea),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn((el) => {
          if (el === fakeTextarea) removed = true;
        }),
      },
      execCommand: vi.fn((cmd: string) => {
        if (cmd === "copy") {
          copiedValue = fakeTextarea.value;
          return true;
        }
        return false;
      }),
    });

    const ok = await copyToClipboard("http://192.168.1.50:3000/d/seq100");
    expect(ok).toBe(true);
    expect(copiedValue).toBe("http://192.168.1.50:3000/d/seq100");
    expect(fakeTextarea.select).toHaveBeenCalled();
    expect(fakeTextarea.setSelectionRange).toHaveBeenCalledWith(0, "http://192.168.1.50:3000/d/seq100".length);
    expect(removed).toBe(true);
    expect(prevFocus).toHaveBeenCalled();
  });

  it("falls back to document.execCommand('copy') when navigator.clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const fakeTextarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    vi.stubGlobal("document", {
      activeElement: null,
      createElement: vi.fn(() => fakeTextarea),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      execCommand: vi.fn(() => true),
    });

    const ok = await copyToClipboard("http://fireshare.lan/d/fallback");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(fakeTextarea.value).toBe("http://fireshare.lan/d/fallback");
  });
});
