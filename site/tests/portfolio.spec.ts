import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { profile } from "../src/content/editorial";

for (const width of [320, 1280]) {
  test(`primary navigation is usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const navigation = page.getByRole("navigation", {
      name: "Portfolio",
      exact: true,
    });
    await expect(
      navigation.getByRole("link", { name: "Interview" }),
    ).toBeVisible();
    if (width === 320) {
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to content" }),
      ).toBeFocused();
    }
    await navigation.getByText("Menu", { exact: true }).click();
    await navigation.getByRole("link", { name: "Résumé", exact: true }).click();
    await expect(page).toHaveURL(/\/resume\/$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Résumé" }),
    ).toBeVisible();
    expect(
      await page.locator("html").evaluate((root) => root.scrollWidth),
    ).toBe(width);
  });
}

test("home exposes still artwork and actions with reduced motion and JavaScript disabled", async ({
  browser,
  baseURL,
}) => {
  const page = await browser.newPage({
    javaScriptEnabled: false,
    reducedMotion: "reduce",
    baseURL,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Angad Sandhu." }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Red wireframe wave" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Explore Interview" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Selected work" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replay motion" }),
  ).toBeHidden();
  await expect(page.locator(".signal-pulse")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.close();
});

test("the opening pulse settles and can be replayed", async ({ page }) => {
  await page.goto("/");
  const sweep = page.locator(".signal-pulse");
  await expect(sweep).toHaveCSS("animation-iteration-count", "1");
  await expect(sweep).toHaveCSS("opacity", "0", { timeout: 3500 });
  await page.getByRole("button", { name: "Replay motion" }).click();
  await expect
    .poll(() =>
      sweep.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.2);
});

test("first-release indexes have no broken local links", async ({
  page,
  request,
}) => {
  const indexes = [
    "/",
    "/projects/",
    "/resume/",
    "/music/",
    "/blog/",
    "/movies/",
    "/interesting/",
    "/interview/",
    "/library/",
  ];
  const targets = new Set<string>();
  for (const index of indexes) {
    const response = await page.goto(index);
    expect(response?.status(), index).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const href of await page
      .locator("a[href]")
      .evaluateAll((links) =>
        links.map((link) => (link as HTMLAnchorElement).href),
      )) {
      if (new URL(href).origin === new URL(page.url()).origin)
        targets.add(href);
    }
  }
  for (const href of targets) {
    const url = new URL(href);
    const response = await request.get(href);
    expect(response.status(), href).toBe(200);
    if (url.hash) {
      await page.goto(href);
      await expect(page.locator(url.hash)).toBeAttached();
    }
  }
});

test("legacy entry points keep their useful targets", async ({ page }) => {
  const output = process.env.PORTFOLIO_PAIRED_PREVIEW_DIR || "dist";
  expect(statSync(join(output, "portfolio-details.html")).isFile()).toBe(true);
  await page.goto("/index.html");
  for (const id of ["hero", "about", "resume", "portfolio", "contact"]) {
    await expect(page.locator(`#${id}`)).toBeAttached();
  }
  const legacy = await page.goto("/portfolio-details.html");
  expect(legacy?.status()).toBe(200);
  await expect(page).toHaveURL(/\/portfolio-details\.html$/);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Browse projects" })
    .click();
  await expect(page).toHaveURL(/\/projects\/$/);
});

test("production indexes and detail routes exclude fixture content", async ({
  page,
  request,
}) => {
  for (const [index, slug] of [
    ["projects", "fixture-project"],
    ["music", "fixture-release"],
  ]) {
    await page.goto(`/${index}/`);
    await expect(
      page.getByText(/fixture project|fixture release/i),
    ).toHaveCount(0);
    expect((await request.get(`/${index}/${slug}/`)).status()).toBe(404);
  }
  expect((await request.get("/fixtures/audio/")).status()).toBe(404);
});

test("résumé publication follows the approved editorial state", async ({
  page,
  request,
}) => {
  await page.goto("/resume/");
  const link = page.getByRole("link", { name: "Download PDF" });
  if (!profile.resume) {
    await expect(
      page.getByText("The résumé is being prepared for publication.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(link).toHaveCount(0);
    return;
  }

  await expect(link).toHaveAttribute("href", "/resume.pdf");
  const response = await request.get("/resume.pdf", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(
    /^application\/pdf(?:;|$)/i,
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    link.click(),
  ]);
  expect(new URL(download.url()).pathname).toBe("/resume.pdf");
  const pdf = await readFile(await download.path());
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
});

test("drafts are excluded and a fixture project links to its details", async ({
  page,
  request,
}) => {
  const origin = "http://127.0.0.1:4390";
  await page.goto(`${origin}/projects/`);
  await page.getByRole("link", { name: "Fixture project" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Fixture project" }),
  ).toBeVisible();
  expect(
    (await request.get(`${origin}/projects/draft-project/`)).status(),
  ).toBe(404);
});

test("the published music video requests its player only after Play", async ({
  page,
  baseURL,
}) => {
  const embedUrl = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  const siteOrigin = new URL("/", baseURL).origin;
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== siteOrigin)
      externalRequests.push(request.url());
  });
  await page.route(embedUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>YouTube</title>" }),
  );

  await page.goto("/music/");
  await page.getByRole("link", { name: "Never Gonna Give You Up" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Never Gonna Give You Up" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Rick Astley’s official music video/),
  ).toBeVisible();
  await expect(page.locator("main img, main iframe")).toHaveCount(0);
  expect(externalRequests).toEqual([]);

  const [response] = await Promise.all([
    page.waitForResponse(embedUrl),
    page.getByRole("button", { name: "Play release" }).click(),
  ]);
  expect(response.ok()).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute("src", embedUrl);
  await page.getByRole("button", { name: "Close player" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("the published music video links to YouTube with JavaScript disabled", async ({
  browser,
  baseURL,
}) => {
  const page = await browser.newPage({ javaScriptEnabled: false, baseURL });
  await page.goto("/music/");
  await page.getByRole("link", { name: "Never Gonna Give You Up" }).click();
  await expect(
    page.getByRole("link", { name: "Watch on YouTube" }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.close();
});

test("the fixture release fetches and plays media only on request", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/fixtures/audio/"))
      mediaRequests.push(request.url());
  });
  await page.goto("http://127.0.0.1:4390/music/");
  await page.getByRole("link", { name: "Fixture release" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Fixture release" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Amber and violet fixture cover" }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(mediaRequests).toHaveLength(0);
  const fetched = page.waitForRequest((request) =>
    request.url().endsWith("/fixtures/audio/"),
  );
  await page.getByRole("button", { name: "Play release" }).click();
  await fetched;
  const player = page.frameLocator("iframe");
  await player.getByRole("button", { name: "Play fixture track" }).click();
  const audio = player.locator("audio");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close player" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("home features a published project alongside the personal introduction", async ({
  page,
}) => {
  await page.goto("/");
  const feature = page.getByRole("region", { name: "Featured project" });
  await expect(
    feature.getByRole("link", { name: "Dagnam.AI" }),
  ).toHaveAttribute("href", "/projects/dagnam-ai/");
});
