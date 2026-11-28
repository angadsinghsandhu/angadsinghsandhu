import { expect, test, type Page } from "@playwright/test";

const revision = "a".repeat(64);
const problemId = "leetcode:1";
const fixtureOrigin = "http://127.0.0.1:4390";

async function progressPage(page: Page) {
  await page.goto(fixtureOrigin);
  await page.setContent(`
    <main>
      <h1>Two Sum</h1>
      <span data-owner-progress-item data-problem-id="${problemId}" data-lesson-revision="${revision}" hidden>
        <button type="button" data-progress-toggle>Mark studied</button>
        <button type="button" data-progress-retry hidden>Retry save</button>
        <span data-progress-status role="status"></span>
      </span>
      <a href="/account/">Private progress</a>
    </main>
  `);
  await page.addScriptTag({
    type: "module",
    content: `
      import { initOwnerProgress } from "/src/client/practice/progress.ts";
      initOwnerProgress(document);
    `,
  });
}

test("failed writes stay unsaved and require confirmation before retry", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/progress/", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          version: 1,
          rows:
            writes < 2
              ? []
              : [
                  {
                    problemId,
                    studied: true,
                    lessonRevision: revision,
                    version: 1,
                    updatedAt: 1200,
                  },
                ],
        },
      });
      return;
    }
    writes++;
    expect(route.request().postDataJSON()).toEqual({
      problemId,
      studied: true,
      lessonRevision: revision,
      expectedVersion: 0,
    });
    if (writes === 1) await route.abort();
    else
      await route.fulfill({
        json: {
          row: {
            problemId,
            studied: true,
            lessonRevision: revision,
            version: 1,
            updatedAt: 1200,
          },
        },
      });
  });
  await progressPage(page);
  await page.getByRole("button", { name: "Mark studied" }).click();
  await expect(page.getByRole("status")).toContainText("Could not save");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Retry save" }).click();
  expect(writes).toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(
    page.getByRole("button", { name: "Mark unstudied" }),
  ).toBeVisible();
  expect(writes).toBe(2);
});

test("a second context sees conflicts, revised content and cleared expired state", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  let expired = false;
  let row = {
    problemId,
    studied: true,
    lessonRevision: "b".repeat(64),
    version: 1,
    updatedAt: 1200,
  };
  try {
    for (const context of [first, second]) {
      await context.route("**/api/progress/", async (route) => {
        if (expired) {
          await route.fulfill({ status: 403 });
          return;
        }
        if (route.request().method() === "GET") {
          await route.fulfill({ json: { version: 1, rows: [row] } });
          return;
        }
        const data = route.request().postDataJSON();
        if (data.expectedVersion !== row.version) {
          await route.fulfill({ status: 409, json: { row } });
          return;
        }
        row = {
          ...row,
          studied: data.studied,
          lessonRevision: data.lessonRevision,
          version: row.version + 1,
        };
        await route.fulfill({ json: { row } });
      });
    }
    const left = await first.newPage();
    const right = await second.newPage();
    await progressPage(left);
    await progressPage(right);
    await expect(left.getByRole("status")).toContainText("Lesson changed");
    await expect(right.getByRole("status")).toContainText("Lesson changed");
    await left.getByRole("button", { name: "Mark unstudied" }).click();
    await expect(
      left.getByRole("button", { name: "Mark studied" }),
    ).toBeVisible();
    await right.getByRole("button", { name: "Mark unstudied" }).click();
    await expect(right.getByRole("status")).toContainText(
      "Changed on another device",
    );
    await expect(
      right.getByRole("button", { name: "Mark studied" }),
    ).toBeVisible();
    row = {
      ...row,
      studied: true,
      lessonRevision: "b".repeat(64),
      version: row.version + 1,
    };
    await right.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(right.getByRole("status")).toContainText("Lesson changed");
    expired = true;
    await right.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      right.getByRole("button", { name: "Mark unstudied" }),
    ).toBeHidden();
    await expect(right.getByRole("heading", { name: "Two Sum" })).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
