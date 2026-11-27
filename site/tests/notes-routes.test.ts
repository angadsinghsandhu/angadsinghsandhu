import { describe, expect, it } from "vitest";
import { claimNotesRoutes } from "../src/lib/notes-routes";
import { portfolioSnapshotV1 } from "../src/lib/notes-snapshot-v1";
import manifest from "./fixtures/notes-snapshot/manifest.v1.json";

function snapshot() {
  return portfolioSnapshotV1.parse(manifest);
}

const existing = new Set(["/", "/interview/", "/projects/"]);

describe("claimNotesRoutes", () => {
  it("claims exact manifest reader routes and their aliases and folder pages", () => {
    const data = snapshot();
    data.entries[0]!.aliases = ["/Moved%20Note/"];
    const claims = claimNotesRoutes({ manifest: data }, existing);
    expect(claims.aliases.get("/Moved%20Note/")).toBe(data.entries[0]!.route);
    expect(claims.pages.has(data.entries[0]!.route)).toBe(true);
    expect(claims.pages.has("/library/books/")).toBe(true);
  });

  it.each([
    "/projects/index.html",
    "/INTERVIEW/",
    "/practice/leetcode/1/",
    "/library/books/",
    "/%2e%2e/",
    "/notes/%2Ffoo/",
  ])("rejects a conflicting or malformed alias %s", (alias) => {
    const data = snapshot();
    data.entries[0]!.aliases = [alias];
    expect(() => claimNotesRoutes({ manifest: data }, existing)).toThrow();
  });
});

it("rejects a directory claim whose parent is an existing public file", () => {
  const data = snapshot();
  data.entries[0]!.aliases = ["/download.pdf/legacy-note/"];
  expect(() =>
    claimNotesRoutes({ manifest: data }, new Set(["/download.pdf"])),
  ).toThrow(/output collision at \/download\.pdf/i);
});

it.each([
  "/licenses/katex.txt/",
  "/licenses/katex.txt/old-note/",
  "/licenses/pagefind.txt/",
  "/licenses/pagefind-vscode-ripgrep.txt/old-note/",
  "/LICENSES/%6Batex.txt/",
])("rejects an alias that collides with a generated license %s", (alias) => {
  const data = snapshot();
  data.entries[0]!.aliases = [alias];
  expect(() => claimNotesRoutes({ manifest: data }, existing)).toThrow(
    /Notes license/u,
  );
});

it("allows an alias elsewhere in the licenses directory", () => {
  const data = snapshot();
  data.entries[0]!.aliases = ["/licenses/legacy/"];
  expect(
    claimNotesRoutes({ manifest: data }, existing).aliases.get(
      "/licenses/legacy/",
    ),
  ).toBe(data.entries[0]!.route);
});

it("rejects a cyclic topic hierarchy before claiming routes", () => {
  const data = snapshot();
  data.organization.topics = [
    { id: "a", parentId: "b", title: "Topic A", summary: "" },
    { id: "b", parentId: "a", title: "Topic B", summary: "" },
  ];
  expect(() => claimNotesRoutes({ manifest: data }, existing)).toThrow(
    /ancestry/i,
  );
});

it("claims the manifest's eligible numeric lesson route exactly once", () => {
  const data = snapshot();
  data.curriculum.lessons.push({
    problemId: "leetcode:1",
    route: "/practice/leetcode/1/",
    status: "verified",
    bodyHtml: "<p>Worked solution</p>",
    headings: [],
    approaches: [],
  });
  expect(
    claimNotesRoutes({ manifest: data }, existing).pages.has(
      "/practice/leetcode/1/",
    ),
  ).toBe(true);
  expect(() =>
    claimNotesRoutes(
      { manifest: data },
      new Set(["/practice/leetcode/1/index.html"]),
    ),
  ).toThrow(/route collision/u);
});
