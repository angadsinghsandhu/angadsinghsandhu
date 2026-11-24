import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { preview } from "astro";
import {
  addedRoute,
  buildNotesPreview,
  encodedAlias,
  stageSite,
  originalRoute,
  previewManifest,
  previewOrigin,
  removedRoute,
  renamedRoute,
} from "./fixtures/notes-preview";

const archive = process.env.PORTFOLIO_NOTES_BROWSER === "archive";
const book = "/notes/books/programming-pytorch-for-deep-learning-ian-pointer/";
const chapter = `${book}chapter-1-getting-started-with-pytorch/`;
const folder =
  "/library/books/folders/Programming~20PyTorch~20for~20Deep~20Learning~20-~20Ian~20Pointer/";
const collection = "/library/collections/programming-pytorch-deep-learning/";
const pdf =
  "/resources/classes/johns-hopkins/sem-1/ml-dl/mock-exams/cs482682-mock-exam-fall-2023-pdf/";
const app =
  "/resources/courses/udemy/react/src/01-getting-started/edited-first-app/src/app-js/";
const externalPdf =
  "/resources/classes/johns-hopkins/sem-3/crypto/3-etherium/lecture8-pdf/";

test("Interview links to available approved study paths or the library", async ({
  page,
}) => {
  await page.goto("/interview/");
  if (archive) {
    await page
      .getByRole("link", { name: "Applied Scientist Interview Preparation" })
      .click();
    await expect(page).toHaveURL(
      /\/library\/paths\/applied-scientist-interview-preparation\/$/,
    );
  } else {
    await expect(
      page.getByRole("link", { name: "Browse Notes" }),
    ).toHaveAttribute("href", "/library/");
  }
});

test("draft curriculum and malformed reader routes are absent", async ({
  request,
}) => {
  for (const route of [
    "/practice/leetcode/",
    "/practice/leetcode/1/",
    "/practice/paths/",
    "/notes/not-a-notes-entry/",
  ])
    expect((await request.get(route)).status(), route).toBe(404);
});

test("isolated preview rebuild adds, edits, renames, and removes reader output", async ({
  page,
  browser,
  request,
}) => {
  const workspace = await mkdtemp(
    join(tmpdir(), "portfolio-notes-preview-test-"),
  );
  try {
    await stageSite(workspace);
    const output = join(workspace, ".generated/notes-preview");
    const html = (route: string) => join(output, route, "index.html");
    await buildNotesPreview(
      workspace,
      "original-export",
      previewManifest(false),
    );
    expect(await readFile(html(originalRoute), "utf8")).toContain(
      "The invariant follows from the definition.",
    );
    expect(await readFile(html("/interview/"), "utf8")).toContain(
      'href="/library/interview/"',
    );
    expect(await readFile(html(removedRoute), "utf8")).toContain(
      "fixtureexclusivegone",
    );
    await buildNotesPreview(workspace, "revised-export", previewManifest(true));
    expect(await readFile(html(renamedRoute), "utf8")).toContain(
      "The revised proof is present.",
    );
    expect(await readFile(html(addedRoute), "utf8")).toContain("Added example");
    await expect(stat(html(removedRoute))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(workspace, "dist"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const server = await preview({
      root: workspace,
      outDir: output,
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    const address = `http://127.0.0.1:${server.port}`;
    try {
      for (const alias of [originalRoute, encodedAlias]) {
        const response = await request.get(address + alias);
        expect(response.status(), alias).toBe(200);
        expect(await response.text()).toContain(
          `<link rel="canonical" href="${previewOrigin}${renamedRoute}"`,
        );
        await page.goto(`${address}${alias}#proof`);
        await expect(page).toHaveURL(`${address}${renamedRoute}#proof`);
        await expect(page.locator(":target")).toHaveText(
          "The revised proof is present.",
        );
      }
      await page.goto(`${address}/search/`);
      await page
        .getByLabel("Search notes and resources")
        .fill("fixtureexclusivegone");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText(/no results/i);
      const noScript = await browser.newContext({ javaScriptEnabled: false });
      const redirects = new Map(
        (await readFile(join(output, "_redirects"), "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => {
            const [source, target, status] = line.split(" ");
            return [source, { target, status }] as const;
          }),
      );
      const canonicalHtml = await readFile(html(renamedRoute));
      const http = createServer((incoming, outgoing) => {
        const path = (incoming.url ?? "/").split("?")[0];
        const rule = redirects.get(path);
        if (rule?.target) {
          outgoing
            .writeHead(Number(rule.status), { location: rule.target })
            .end();
        } else if (path === renamedRoute) {
          outgoing
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(canonicalHtml);
        } else {
          outgoing.writeHead(404).end();
        }
      });
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const listener = http.address();
      if (!listener || typeof listener === "string")
        throw new Error("Missing HTTP rehearsal listener");
      const rehearsal = `http://127.0.0.1:${listener.port}`;
      try {
        const fallback = await noScript.newPage();
        await fallback.goto(address + encodedAlias);
        await expect(fallback).toHaveURL(address + renamedRoute);
        for (const alias of [originalRoute, encodedAlias]) {
          const response = await request.get(rehearsal + alias, {
            maxRedirects: 0,
          });
          expect(response.status()).toBe(308);
          expect(response.headers()["location"]).toBe(renamedRoute);
          await fallback.goto(`${rehearsal}${alias}#proof`);
          await expect(fallback).toHaveURL(`${rehearsal}${renamedRoute}#proof`);
          await expect(fallback.locator(":target")).toHaveText(
            "The revised proof is present.",
          );
        }
      } finally {
        await noScript.close();
        http.close();
        await once(http, "close");
      }
    } finally {
      await server.stop();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test.describe("validated archive", () => {
  test.skip(
    !archive,
    "Run against the explicitly built archive with PORTFOLIO_NOTES_BROWSER=archive",
  );

  test("folder links lead to the canonical reader and preserved fragment without JavaScript", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      baseURL,
    });
    const page = await context.newPage();
    try {
      await page.goto(folder);
      await page.locator(`[data-library-notes] a[href="${book}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${book}$`));
      await page.goto(`${chapter}#tensor-broadcasting`);
      await expect(
        page.getByRole("heading", { name: "Tensor Broadcasting" }),
      ).toBeVisible();
      await expect(page.locator(":target")).toHaveAttribute(
        "id",
        "tensor-broadcasting",
      );
      await expect(page.locator("link[rel=canonical]")).toHaveAttribute(
        "href",
        `${previewOrigin}${chapter}`,
      );
    } finally {
      await context.close();
    }
  });

  test("mobile reader supports Browse, Search and On this page by keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(chapter);
    const browse = page.getByRole("button", { name: "Browse", exact: true });
    await browse.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("link", { name: "Folder tree", exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(browse).toBeFocused();
    await expect(
      page.getByRole("link", { name: "Search", exact: true }),
    ).toHaveAttribute("href", "/search/");
    await page
      .getByText("On this page", { exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("link", { name: "Tensor Broadcasting" }).click();
    await expect(page).toHaveURL(/#tensor-broadcasting$/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });

  for (const width of [768, 1280]) {
    test(`reader content and fragment stay usable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${chapter}#tensor-broadcasting`);
      await expect(page.locator(":target")).toHaveText("Tensor Broadcasting");
      await expect(
        page.getByRole("link", { name: "Search", exact: true }).first(),
      ).toBeAttached();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });
  }

  test("organization links keep book chapters and React project trees", async ({
    page,
  }) => {
    await page.goto(collection);
    await page
      .getByRole("link", {
        name: "Chapter 1: Getting Started with PyTorch",
        exact: true,
      })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Chapter 1: Getting Started with PyTorch",
    );
    await page.goto(
      "/library/collections/react-complete-guide/groups/project-01-getting-started-edited-first-app/",
    );
    const files = page.locator("[data-project-files]");
    const appLink = files.getByRole("link", { name: "App.js", exact: true });
    await expect(appLink).toHaveAttribute("href", app);
    await files.locator("summary").getByText("src", { exact: true }).click();
    await expect(appLink).toBeHidden();
    await files.locator("summary").getByText("src", { exact: true }).click();
    await expect(appLink).toBeVisible();
  });

  test("scoped search indexes learning text and exposes supplemental resources in All files", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/search/");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
    const collectionFilter = page.getByLabel("Collection");
    const filterBounds = await collectionFilter.boundingBox();
    expect(filterBounds).not.toBeNull();
    expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(320);
    await page
      .getByLabel("Search notes and resources")
      .fill("tensor broadcasting");
    await page
      .getByLabel("Collection")
      .selectOption("programming-pytorch-deep-learning");
    await page.getByLabel("Topic").selectOption("frameworks-gpu-computing");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(`ol a[href^="${chapter}"]`).first()).toBeVisible({
      timeout: 15000,
    });
    await page.getByLabel("Collection").selectOption("react-complete-guide");
    await page.getByLabel("Topic").selectOption("");
    await page.getByLabel("Kind").selectOption("code");
    await page
      .getByLabel("Search notes and resources")
      .fill("vanilla javascript requires imperative programming");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(/no results/i);
    await page.getByLabel("Scope").selectOption("files");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(`ol a[href="${app}"]`).first()).toBeVisible();
  });

  test("PDF preview renders a real page and offers original source fallback", async ({
    page,
  }) => {
    await page.goto(pdf);
    const preview = page.getByRole("region", {
      name: "PDF preview",
      exact: true,
    });
    await preview.scrollIntoViewIfNeeded();
    await expect(preview.locator("canvas")).toBeVisible({ timeout: 15000 });
    await expect(
      preview.getByRole("button", { name: "Next PDF page" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("link", { name: "Open PDF", exact: true }),
    ).toHaveAttribute("href", /\/content-assets\/[^/]+\.pdf$/);
    const pdfDownload = page.getByRole("link", {
      name: "Download PDF",
      exact: true,
    });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfDownload.click(),
    ]);
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    await page.goto(externalPdf);
    await expect(
      page.getByRole("link", { name: "Open external source" }),
    ).toHaveAttribute(
      "href",
      /github\.com\/angadsinghsandhu\/Notes\/blob\/.+\/Lecture8\.pdf$/,
    );
    await expect(
      page.getByRole("region", { name: "PDF preview", exact: true }),
    ).toHaveCount(0);
  });
});
