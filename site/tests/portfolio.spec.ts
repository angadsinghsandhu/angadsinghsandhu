import { statSync } from "node:fs";
import { expect, test } from "@playwright/test";

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
  expect(statSync("dist/portfolio-details.html").isFile()).toBe(true);
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
  await page.goto("/resume/");
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
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
  const audio = page.frameLocator("iframe").locator("audio");
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).currentTime),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close player" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
});
