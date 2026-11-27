import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { preview } from "astro";
import {
  originalRoute,
  previewManifest,
  stageSite,
} from "./fixtures/notes-preview";
import type { PortfolioSnapshotV1 } from "../src/lib/notes-snapshot-v1";

function manifest(): PortfolioSnapshotV1 {
  const problem = (number: number, title: string, slug: string) => ({
    id: `leetcode:${number}`,
    number,
    status: "verified" as const,
    title,
    slug,
    officialUrl: `https://leetcode.com/problems/${slug}/`,
    domain: "algorithm" as const,
    officialQuestionObservedOn: "2026-11-23",
  });
  const notes = previewManifest(false);
  const archive = notes.entries[0]!;
  return {
    schemaVersion: 1,
    mode: "preview",
    sourceSha: "1".repeat(40),
    entries: notes.entries,
    organization: notes.organization,
    assets: [],
    verifiedCurriculumIds: [1, 20],
    curriculum: {
      generation: "a".repeat(64),
      problems: [
        {
          ...problem(1, "Two Sum", "two-sum"),
          difficulty: "easy",
          topics: ["hash-table"],
          companies: [
            {
              companyId: "example-employer",
              companyName: "Example Employer",
              observedOn: "2026-11-23",
            },
          ],
        },
        {
          ...problem(20, "Valid Parentheses", "valid-parentheses"),
          difficulty: "medium",
          topics: ["stack"],
          companies: [],
        },
      ],
      lessons: [1, 20].map((number) => ({
        problemId: `leetcode:${number}`,
        route: `/practice/leetcode/${number}/`,
        status: "verified",
        bodyHtml: "<p>Test lesson</p>",
        approaches: [],
        headings: [],
      })),
      paths: [
        {
          id: "sample",
          title: "Practice sequence",
          description: "Learn the foundations.",
          rootIds: ["first", "second"],
          nodes: [
            {
              id: "first",
              kind: "stage",
              title: "First stage",
              childIds: ["one", "pending"],
              prerequisiteIds: [],
            },
            {
              id: "second",
              kind: "stage",
              title: "Second stage",
              childIds: ["one", "twenty"],
              prerequisiteIds: [],
            },
            {
              id: "one",
              kind: "problem",
              problemId: "leetcode:1",
              title: "Two Sum",
              childIds: [],
              prerequisiteIds: [],
            },
            {
              id: "twenty",
              kind: "problem",
              problemId: "leetcode:20",
              title: "Valid Parentheses",
              childIds: [],
              prerequisiteIds: ["one"],
            },
            {
              id: "pending",
              kind: "problem",
              problemId: "leetcode:2",
              childIds: [],
              prerequisiteIds: [],
            },
          ],
        },
      ],
      pendingPathLabels: [
        {
          pathId: "sample",
          nodeId: "pending",
          problemId: "leetcode:2",
          title: "Problem 2",
        },
      ],
      sourceVariants: [
        {
          sourceId: archive.id,
          sourceRoute: originalRoute,
          problemId: "leetcode:1",
          lessonRoute: "/practice/leetcode/1/",
        },
      ],
      traceAssets: [],
    },
  };
}

test("practice discovery preserves filters and exposes the study sequence without JavaScript", async ({
  page,
  browser,
}) => {
  const workspace = await mkdtemp(join(tmpdir(), "practice-discovery-"));
  try {
    await stageSite(workspace);
    const data = manifest();
    const bytes = JSON.stringify(data);
    const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    const snapshot = join(workspace, ".generated/notes", manifestSha256);
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "manifest.json"), bytes);
    await promisify(execFile)("npm", ["run", "build", "--", "--ignore-lock"], {
      cwd: workspace,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PORTFOLIO_ORIGIN: "https://portfolio-preview.example",
        PORTFOLIO_NOTES_BUILD_RECEIPT: JSON.stringify({
          mode: data.mode,
          sourceSha: data.sourceSha,
          manifestSha256,
        }),
      },
    });
    const server = await preview({
      root: workspace,
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    const address = `http://127.0.0.1:${server.port}`;
    try {
      await page.goto(
        `${address}/practice/leetcode/?q=20&topic=stack&difficulty=medium&company=unknown`,
      );
      const resultList = page.getByRole("list", { name: "Matching lessons" });
      await expect(resultList.getByRole("link")).toHaveText(
        "20. Valid Parentheses",
      );
      await expect(page.getByText("Company evidence unknown")).toBeVisible();
      await page.getByRole("link", { name: "Clear filters" }).click();
      await page.getByLabel("Number or title").fill("two sum");
      await page
        .getByRole("combobox", { name: "Company", exact: true })
        .selectOption("example-employer");
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page).toHaveURL(/q=two\+sum&company=example-employer$/u);
      await expect(resultList.getByRole("link")).toHaveText("1. Two Sum");
      await page.reload();
      await expect(page.getByLabel("Number or title")).toHaveValue("two sum");
      await expect(resultList.getByRole("link")).toHaveText("1. Two Sum");
      await page
        .getByRole("combobox", { name: "Difficulty", exact: true })
        .selectOption("hard");
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText(
        "No lessons match these filters.",
      );
      await page.goBack();
      await expect(resultList.getByRole("link")).toHaveText("1. Two Sum");

      const noScript = await browser.newContext({ javaScriptEnabled: false });
      try {
        const fallback = await noScript.newPage();
        await fallback.goto(`${address}/practice/leetcode/`);
        await expect(
          fallback.locator('form[aria-label="Filter lessons"]'),
        ).toBeHidden();
        await expect(
          fallback
            .getByRole("list", { name: "Matching lessons" })
            .getByRole("link"),
        ).toHaveCount(2);
        await fallback.goto(address + originalRoute);
        await fallback
          .getByRole("link", { name: "Practice 1. Two Sum" })
          .click();
        await expect(fallback).toHaveURL(/practice\/leetcode\/1\/$/u);
        await fallback.goto(`${address}/practice/leetcode/`);
        await fallback.getByRole("link", { name: "Study paths" }).click();
        await fallback.getByRole("link", { name: "Practice sequence" }).click();
        await expect(
          fallback.getByText("2 of 3 targets have verified lessons."),
        ).toBeVisible();
        const outline = fallback.getByRole("list", { name: "Ordered outline" });
        await expect(outline.getByRole("link")).toHaveText([
          "1. Two Sum",
          "20. Valid Parentheses",
        ]);
        await expect(outline.getByText("2. Problem 2")).toBeVisible();
        await fallback.getByText("Second stage", { exact: true }).click();
        await expect(
          fallback.getByRole("link", {
            name: "Two Sum (see first appearance)",
          }),
        ).toBeVisible();
      } finally {
        await noScript.close();
      }
    } finally {
      await server.stop();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
