import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsecureContextNotice, UploadForm } from "./upload-form";

describe("insecure context notice", () => {
  it("explains that uploading needs HTTPS or localhost", () => {
    const html = renderToStaticMarkup(<InsecureContextNotice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("https:// pages or on localhost");
  });

  it("isn't shown before the browser has said whether the page is secure", () => {
    const html = renderToStaticMarkup(
      <UploadForm expiryOptions={["1d"]} expiryDefault="1d" chunkSize={5 * 1024 * 1024} parallelFiles={1} />,
    );
    expect(html).not.toContain("Uploading needs a secure connection");
  });
});
