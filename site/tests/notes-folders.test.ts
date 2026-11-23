import { expect, it } from "vitest";
import {
  buildFolders,
  flattenFolders,
  folderRoute,
} from "../src/lib/notes-folders";
import { portfolioSnapshotV1 } from "../src/lib/notes-snapshot-v1";
import manifest from "./fixtures/notes-snapshot/manifest.v1.json";

it("preserves each source segment through reversible folder escaping", () => {
  const segments = ["a b", "a-b", "a/b", "a%2Fb", "~20", ".", "..", "é?#"];
  const routes = segments.map((segment) => folderRoute("books", [segment]));
  expect(new Set(routes).size).toBe(segments.length);
  expect(folderRoute("books", ["a b", "Chapter 1"])).toBe(
    "/library/books/folders/a~20b/Chapter~201/",
  );
  for (const route of routes)
    expect(new URL(route, "https://example.test").pathname).toBe(route);
});

it("keeps similar folder names distinct and counts only published snapshot entries", () => {
  const [entry] = portfolioSnapshotV1.parse(manifest).entries;
  const learning = { ...entry!, groupSegments: ["Book", "Chapter 1"] };
  const supplemental = {
    ...entry!,
    role: "supplemental" as const,
    groupSegments: ["Book", "Chapter-1"],
  };
  const folders = buildFolders([learning, supplemental]);
  const books = folders.find(({ section }) => section === "books")!;
  expect(flattenFolders(folders)).toHaveLength(9);
  expect([books.noteCount, books.resourceCount]).toEqual([1, 1]);
  expect(books.children[0]!.children.map(({ label }) => label)).toEqual([
    "Chapter 1",
    "Chapter-1",
  ]);
  expect(books.children[0]!.children[0]!.entries).toEqual([learning]);
  expect(books.children[0]!.children[1]!.entries).toEqual([supplemental]);
});
