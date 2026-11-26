import { readFile, writeFile } from "node:fs/promises";
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";

export function physicalLines(text: string): number {
  if (!text) return 0;
  return (
    (text.match(/\r\n|[\r\n]/gu)?.length ?? 0) + (/[\r\n]$/u.test(text) ? 0 : 1)
  );
}

const rawText = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "noscript",
]);

export function compactHtml(html: string): string {
  if (physicalLines(html) <= 500) return html;
  const spans: { start: number; end: number }[] = [];
  const stack = [...fromHtml(html).children];
  while (stack.length) {
    const node = stack.pop()!;
    if (
      node.type === "element" &&
      !rawText.has(node.tagName) &&
      node.properties.contentEditable !== "true"
    )
      stack.push(...node.children);
    if (node.type === "text" && node.position) {
      const { start, end } = node.position;
      if (start.offset !== undefined && end.offset !== undefined)
        spans.push({ start: start.offset, end: end.offset });
    }
  }
  let next = 0;
  const parts = [];
  for (const { start, end } of spans.sort(
    (left, right) => left.start - right.start,
  )) {
    if (start < next) throw new Error("Overlapping HTML text positions");
    parts.push(
      html.slice(next, start),
      html.slice(start, end).replace(/\r\n|[\r\n]/gu, "&#10;"),
    );
    next = end;
  }
  parts.push(html.slice(next));
  return parts.join("");
}

export async function compactOutputHtml(file: string) {
  const html = await readFile(file, "utf8");
  const compact = compactHtml(html);
  if (physicalLines(compact) > 500)
    throw new Error(`Generated HTML exceeds 500 physical lines: ${file}`);
  if (compact === html) return;
  if (toHtml(fromHtml(html)) !== toHtml(fromHtml(compact)))
    throw new Error(`HTML compaction changed the rendered document: ${file}`);
  await writeFile(file, compact);
}

// Portfolio's custom search uses the Pagefind API directly.
export const unusedPagefindFiles = [
  "pagefind-component-ui.css",
  "pagefind-component-ui.js",
  "pagefind-highlight.js",
  "pagefind-modular-ui.css",
  "pagefind-modular-ui.js",
  "pagefind-ui.css",
  "pagefind-ui.js",
];
