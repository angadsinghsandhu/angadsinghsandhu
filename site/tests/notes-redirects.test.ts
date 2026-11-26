import { expect, test } from "vitest";
import {
  renderNotesRedirects,
  renderSitemap,
} from "../scripts/notes-redirects.ts";

test("renders deterministic exact same-origin aliases without a target fragment", () => {
  expect(
    renderNotesRedirects(
      new Map([
        ["/z%20old/", "/notes/books/example/"],
        ["/A.html", "/notes/books/example/"],
      ]),
    ),
  ).toBe(
    "/A.html /notes/books/example/ 308\n/z%20old/ /notes/books/example/ 308\n",
  );
});

test("rejects alias wildcard syntax and external redirect targets", () => {
  for (const [alias, target] of [
    ["/old/*", "/notes/books/example/"],
    ["//other.example/old/", "/notes/books/example/"],
    ["/old/", "//other.example/new/"],
    ["/old/", "/notes/books/example/#proof"],
    ["/old/", "/notes/books/example/?draft=1"],
  ] as const)
    expect(() => renderNotesRedirects(new Map([[alias, target]]))).toThrow(
      "Cannot render Notes redirect",
    );
});

test("rejects redirects beyond the physical line limit", () => {
  const aliases = new Map(
    Array.from({ length: 501 }, (_, index) => [
      `/old/${index}/`,
      "/notes/books/example/",
    ]),
  );
  expect(() => renderNotesRedirects(aliases)).toThrow("500-line");
  aliases.delete("/old/500/");
  expect(renderNotesRedirects(aliases).trimEnd().split("\n")).toHaveLength(500);
});

test("writes stable sitemap parts within the physical line limit", () => {
  const urls = Array.from(
    { length: 1000 },
    (_, index) => `https://portfolio.example/notes/${index}/`,
  );
  const sitemap = renderSitemap("https://portfolio.example", urls);
  expect(sitemap).toEqual(
    renderSitemap("https://portfolio.example", urls.toReversed()),
  );
  expect([...sitemap.keys()]).toEqual([
    "sitemap.xml",
    "sitemap-1.xml",
    "sitemap-2.xml",
    "sitemap-3.xml",
  ]);
  for (const content of sitemap.values())
    expect(content.trimEnd().split("\n").length).toBeLessThanOrEqual(500);
  for (const url of urls)
    expect(
      [...sitemap.values()].filter((content) =>
        content.includes(`<loc>${url}</loc>`),
      ),
    ).toHaveLength(1);
});

test("rejects a declaration longer than the Pages character limit", () => {
  const target = "/notes/books/example/";
  const alias = "/" + "a".repeat(1000 - `/ ${target} 308`.length);
  expect(
    renderNotesRedirects(new Map([[alias, target]])).trimEnd(),
  ).toHaveLength(1000);
  expect(() => renderNotesRedirects(new Map([[alias + "a", target]]))).toThrow(
    "1000-character",
  );
});
