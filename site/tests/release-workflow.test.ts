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

const releases = readFileSync(
  new URL("../../.github/workflows/portfolio-release.yml", import.meta.url),
  "utf8",
);
const production = releases.split("\n  publish:\n")[1];

it("keeps source and candidate build jobs separate from the protected production job", () => {
  expect(production).toBeDefined();
  expect(production).toContain("python-version: 3.12.14");
  expect(production).toContain("needs: [select, build]");
  expect(production).toContain("environment: portfolio-production");
  expect(production).toContain(
    "PORTFOLIO_SELECTED_RECEIPT: ${{ needs.build.outputs.release_receipt }}",
  );
  expect(production).toContain(
    "PORTFOLIO_SELECTED_NOTES_RUN_ATTEMPT: ${{ needs.select.outputs.notes_run_attempt }}",
  );
  expect(production).toContain(
    "PORTFOLIO_SELECTED_ORIGIN: ${{ needs.select.outputs.origin }}",
  );
  expect(releases.split("\n  publish:\n")[0]).not.toMatch(
    /CLOUDFLARE|PRODUCTION_(?:JOURNAL|PAGES)_TOKEN/,
  );
});

it("queues publication and operator work on the same protected target", () => {
  const operator = readFileSync(
    new URL("../../.github/workflows/portfolio-rollback.yml", import.meta.url),
    "utf8",
  );
  for (const job of [production, operator]) {
    expect(job).toMatch(
      /concurrency:\n {6}group: portfolio-production\n {6}cancel-in-progress: false\n {6}queue: max/,
    );
    expect(job).toContain("environment: portfolio-production");
    expect(job).toContain("github.ref_protected");
    expect(job).toContain("persist-credentials: false");
    expect(job).toContain("node-version: 24.18.1");
    const [before, credentials] = job.split(
      "run: node scripts/release-production.ts --check",
    );
    expect(before).toContain("npm run bootstrap");
    expect(before).toContain("= true ]");
    expect(before).not.toContain("secrets.");
    expect(credentials).toContain(
      "if: steps.activation.outputs.enabled == 'true'",
    );
    expect(credentials).toContain("secrets.PORTFOLIO_PRODUCTION_PAGES_TOKEN");
    expect(credentials).toContain("secrets.PORTFOLIO_PRODUCTION_JOURNAL_TOKEN");
    expect(credentials).toContain("run: node scripts/release-production.ts\n");
  }
  expect(operator).toContain("workflow_dispatch:");
  expect(operator).toContain("PORTFOLIO_PRODUCTION_OPERATOR_ID");
  expect(operator).not.toContain("PORTFOLIO_PRODUCTION_ARTIFACT_TOKEN");
  expect(operator).toContain("github.run_attempt == '1'");
  expect(operator).not.toContain("${{ inputs.");
});

it("supports a checked paired archive with the Worker credential only in publication", () => {
  const [candidate, publish] = releases.split("\n  publish:\n");
  expect(candidate).toMatch(
    /--paired-release[\s\S]*upload-artifact@[\s\S]*CANDIDATE_PRACTICE_BUNDLE/,
  );
  expect(candidate).not.toContain("PORTFOLIO_PRODUCTION_TRACE_TOKEN");
  expect(publish).toContain("secrets.PORTFOLIO_PRODUCTION_TRACE_TOKEN");
});
