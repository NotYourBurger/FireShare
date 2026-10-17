import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KineticQuote } from "./kinetic-typography";

describe("kinetic typography", () => {
  it("gives assistive technology the whole quote and its author before the poster is laid out", () => {
    const html = renderToStaticMarkup(
      <KineticQuote quote="In the blur of life, find your focus." author="Ion Lucin" label="Stillness" studyId="01" />,
    );
    expect(html).toContain('class="visually-hidden"');
    expect(html).toContain("In the blur of life, find your focus.");
    expect(html).toContain("Ion Lucin");
  });
});
