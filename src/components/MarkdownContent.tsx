import type { ElementType, ReactNode } from "react";

type ListMarker = {
  indent: number;
  ordered: boolean;
  order: number;
  content: string;
};

const INLINE_TOKEN =
  /`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

function inline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const key = `${prefix}-inline-${matchIndex++}`;
    const [, code, linkText, linkHref, strongA, strongB, strike, emphasisA, emphasisB] = match;
    if (code !== undefined) {
      nodes.push(<code key={key}>{code}</code>);
    } else if (linkText !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref);
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {linkText}
          </a>
        ) : (
          linkText
        ),
      );
    } else if (strongA !== undefined || strongB !== undefined) {
      nodes.push(<strong key={key}>{strongA ?? strongB}</strong>);
    } else if (strike !== undefined) {
      nodes.push(<del key={key}>{strike}</del>);
    } else if (emphasisA !== undefined || emphasisB !== undefined) {
      nodes.push(<em key={key}>{emphasisA ?? emphasisB}</em>);
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function listMarker(line: string): ListMarker | null {
  const match = /^(\s*)([-+*]|(\d+)[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1]?.replace(/\t/g, "  ").length ?? 0,
    ordered: Boolean(match[3]),
    order: Number(match[3] ?? 1),
    content: match[4] ?? "",
  };
}

function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}(```|~~~)/.test(line) ||
    /^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line) ||
    listMarker(line) !== null
  );
}

function parseList(
  lines: string[],
  start: number,
  prefix: string,
): { node: ReactNode; next: number } {
  const first = listMarker(lines[start] ?? "");
  if (!first) return { node: null, next: start + 1 };

  const items: string[][] = [];
  let current: string[] | null = null;
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      let next = index + 1;
      while (next < lines.length && !lines[next]?.trim()) next += 1;
      const nextMarker = listMarker(lines[next] ?? "");
      if (
        current &&
        nextMarker &&
        nextMarker.indent >= first.indent &&
        (nextMarker.indent > first.indent || nextMarker.ordered === first.ordered)
      ) {
        current.push("");
        index += 1;
        continue;
      }
      break;
    }

    const marker = listMarker(line);
    if (marker) {
      if (marker.indent < first.indent) break;
      if (marker.indent === first.indent) {
        if (marker.ordered !== first.ordered) break;
        current = [marker.content];
        items.push(current);
        index += 1;
        continue;
      }
    }

    if (!current) break;
    const indent = /^\s*/.exec(line)?.[0].replace(/\t/g, "  ").length ?? 0;
    if (indent <= first.indent) break;
    current.push(line.slice(Math.min(first.indent + 2, line.length)));
    index += 1;
  }

  const children = items.map((item, itemIndex) => (
    <li key={`${prefix}-item-${itemIndex}`}>{blocks(item, `${prefix}-${itemIndex}`)}</li>
  ));
  const className = first.ordered ? "message-list list-decimal" : "message-list list-disc";
  const node = first.ordered ? (
    <ol className={className} start={first.order}>
      {children}
    </ol>
  ) : (
    <ul className={className}>{children}</ul>
  );
  return { node, next: index };
}

function blocks(lines: string[], prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let sequence = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const delimiter = fence[1]?.[0] ?? "`";
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s{0,3}${delimiter}{3,}\\s*$`).test(lines[index] ?? "")
      ) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre className="message-code-block" key={`${prefix}-${sequence++}`}>
          <code className={fence[2] ? `language-${fence[2]}` : undefined}>
            {codeLines.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 1);
      const Tag = `h${level}` as ElementType;
      nodes.push(
        <Tag className="message-heading" key={`${prefix}-${sequence++}`}>
          {inline(heading[2] ?? "", `${prefix}-heading-${sequence}`)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(<hr className="message-rule" key={`${prefix}-${sequence++}`} />);
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote className="message-quote" key={`${prefix}-${sequence++}`}>
          {blocks(quote, `${prefix}-quote-${sequence}`)}
        </blockquote>,
      );
      continue;
    }

    if (listMarker(line)) {
      const parsed = parseList(lines, index, `${prefix}-list-${sequence}`);
      nodes.push(<div key={`${prefix}-${sequence++}`}>{parsed.node}</div>);
      index = Math.max(parsed.next, index + 1);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index]?.trim() && !isBlockStart(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    nodes.push(
      <p className="message-paragraph" key={`${prefix}-${sequence++}`}>
        {inline(paragraph.join("\n"), `${prefix}-paragraph-${sequence}`)}
      </p>,
    );
  }
  return nodes;
}

export function MarkdownContent({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`message-prose ${className}`}>
      {blocks(content.replace(/\r\n?/g, "\n").split("\n"), "message")}
    </div>
  );
}
