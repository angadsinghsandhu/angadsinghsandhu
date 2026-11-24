import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/portfolio.yml", import.meta.url),
  "utf8",
);

it("runs the combined build and archive checks after the standalone gate", () => {
  const verify = workflow.match(/^ {2}verify:\n((?:^ {4}.*\n)+)/m)?.[1];
  expect(verify).toContain("name: Verify portfolio");
  expect(verify).toMatch(
    /npm run verify\n[\s\S]*scripts\/export-portfolio\.ts[\s\S]*npm run import:notes[\s\S]*npm run build:release[\s\S]*npm run verify:output[\s\S]*npm run test:browser/,
  );
  expect(verify).toContain("PORTFOLIO_NOTES_BROWSER: archive");
});

it("uses the rehearsal origin for archive browser checks", () => {
  expect(workflow).toContain(
    "PORTFOLIO_ORIGIN: https://portfolio-preview.example\n",
  );
});

it("checks out an immutable Notes revision with read-only access", () => {
  expect(workflow).toMatch(/^permissions:\n {2}contents: read\n\njobs:/m);
  const checkouts = workflow.match(
    /^ {6}- uses: actions\/checkout@[^\n]+\n(?:^ {8}.*\n)*/gm,
  );
  expect(checkouts).toHaveLength(2);
  for (const checkout of checkouts ?? []) {
    expect(checkout).toContain("persist-credentials: false\n");
  }
  expect(checkouts?.[1]).toMatch(
    /repository: angadsinghsandhu\/Notes\n {10}ref: [a-f0-9]{40}\n/,
  );
  expect(workflow).toContain(
    "NOTES_REVISION: ${{ steps.notes.outputs.commit }}",
  );
});
