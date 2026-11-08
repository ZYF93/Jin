import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders formatted paragraphs and nested lists as Markdown", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={[
          "1. **WAL is the source of truth** — `init/wal.jsonl`",
          "",
          "2. **Rescan + clear history**",
          "  - Re-parse the project files",
          "  - Compare against the current baseline",
        ].join("\n")}
      />,
    );

    assert.match(markup, /<ol[^>]*>/);
    assert.match(markup, /<ul[^>]*>/);
    assert.match(markup, /<strong>WAL is the source of truth<\/strong>/);
    assert.match(markup, /<code>init\/wal\.jsonl<\/code>/);
    assert.doesNotMatch(markup, /\*\*|`/);
  });

  it("escapes raw HTML and rejects unsafe link protocols", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'<img src=x onerror="alert(1)"> [unsafe](javascript:alert(1))'} />,
    );

    assert.match(markup, /&lt;img/);
    assert.doesNotMatch(markup, /<img/);
    assert.doesNotMatch(markup, /href="javascript:/);
  });
});
