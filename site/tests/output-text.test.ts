import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import { expect, test } from "vitest";
import { compactHtml, physicalLines } from "../scripts/output-text.ts";

test("long archive HTML preserves rendered text, encoded characters and anchors", () => {
  const html =
    '<!doctype html><pre>\n<code id="sample">\n' +
    "&lt;item&gt;  &amp; value\n".repeat(600) +
    "</code></pre><script>let message = `x\ny`;</script>";
  const result = compactHtml(html);
  expect(physicalLines(result)).toBeLessThanOrEqual(500);
  expect(toHtml(fromHtml(result))).toBe(toHtml(fromHtml(html)));
});

test("counts physical lines the same way for LF, CRLF, and CR", () => {
  expect(physicalLines("a\nb\rc\r\n")).toBe(3);
  expect(physicalLines("a\nb")).toBe(2);
  expect(physicalLines("")).toBe(0);
});
