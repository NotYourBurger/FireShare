import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManagementLink } from "./upload-form";

describe("management link at creation", () => {
  it("asks the uploader to save it, with a copy button", () => {
    const html = renderToStaticMarkup(<ManagementLink url="http://x/m/AAAAAAAAAAAAAAAAAAAAAA" />);
    expect(html).toContain("Save your management link");
    expect(html).toContain("shown only this once");
    expect(html).toContain('value="http://x/m/AAAAAAAAAAAAAAAAAAAAAA"');
    expect(html).toContain('aria-label="Copy management link"');
    expect(html).toContain('href="/recent"');
  });
});
