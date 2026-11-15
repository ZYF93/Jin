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

describe("MarkdownContent tables", () => {
  it("renders a GFM table with header alignment and escaped pipes", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={[
          "| Name | Count | Note |",
          "|:-----|------:|:----:|",
          "| alpha | 1 | a\\|b |",
          "| beta  | 2 |     |",
        ].join("\n")}
      />,
    );
    assert.ok(markup.includes("<table"), "expected a table element");
    assert.ok(markup.includes("<th"), "expected header cells");
    assert.ok(markup.includes("<td"), "expected body cells");
    assert.ok(markup.includes("alpha"), "expected a body value");
    assert.ok(markup.includes("a|b"), "escaped pipe should render as a literal pipe");
  });

  it("leaves a lone pipe in a paragraph as text (no separator row)", () => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={"plain text with a pipe | but no separator row"} />,
    );
    assert.ok(!markup.includes("<table"), "no table without a separator row");
    assert.ok(markup.includes("plain text"), "text preserved");
  });
});
