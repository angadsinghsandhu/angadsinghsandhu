import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import type { AlgorithmTrace } from "../../../src/client/practice/trace-model";

const origin = "https://practice.test";
const implementationSha256 = "a".repeat(64);
const queueFrames = Array.from({ length: 4 }, (_, index) => ({
  stepId: `queue-${index}`,
  codeLines: [(index % 2) + 1],
  explanation: `Visit queue position ${index}.`,
  state: { kind: "queue" as const, items: [`word-${index}`, "<b>text</b>"] },
  highlights: [{ index: 0 }],
}));
const examples: AlgorithmTrace[] = [
  {
    version: 1,
    problemId: "leetcode:127",
    approachId: "bfs",
    exampleId: "queue",
    implementationSha256,
    result: 1,
    frames: queueFrames,
  },
  {
    version: 1,
    problemId: "leetcode:127",
    approachId: "bfs",
    exampleId: "graph",
    implementationSha256,
    result: 0,
    frames: [
      {
        stepId: "graph-0",
        codeLines: [1, 2],
        explanation: "Visit the graph.",
        state: {
          kind: "graph",
          nodes: [
            { id: "source", value: "hit" },
            { id: "target", value: "hot" },
          ],
          edges: [{ from: "source", to: "target" }],
        },
        highlights: [{ nodeId: "target" }, { from: "source", to: "target" }],
      },
    ],
  },
];
const payload = JSON.stringify({ version: 1, traces: examples });
const sha256 = createHash("sha256").update(payload).digest("hex");
const tracePath = `/practice-traces/${sha256}.json`;

const fixture = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  header { height: 100vh; }
  button, select { min-height: 44px; }
  [aria-current="step"], .trace-current-line { background: gold; }
</style>
<header>Practice fixture</header>
<section data-practice-approach="bfs">
  <pre data-practice-code><span data-practice-line="1">first line</span>
<span data-practice-line="2">second line</span></pre>
  <div id="player" data-problem-id="leetcode:127" data-approach-id="bfs"
    data-implementation-sha256="${implementationSha256}" data-trace-url="${tracePath}"
    data-trace-sha256="${sha256}" data-trace-bytes="${Buffer.byteLength(payload)}">
    <button type="button" data-player-load hidden>Load interactive trace</button>
    <p role="status" data-player-status></p>
    <div data-player-panel hidden>
      <div data-player-controls>
        <label>Example <select data-player-example><option>queue</option><option>graph</option></select></label>
        <label>Speed <select data-player-speed><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label>
        <button type="button" data-player-previous>Previous</button>
        <button type="button" data-player-next>Next</button>
        <button type="button" data-player-play>Play</button>
        <button type="button" data-player-reset>Reset</button>
      </div>
      <p data-player-motion-note hidden>Automatic playback is disabled.</p>
      <p data-player-step></p>
      <p data-player-explanation></p>
      <p data-player-code-lines></p>
      <div data-player-state></div>
    </div>
  </div>
  ${examples.map(({ exampleId, frames }) => `<ol data-practice-example="${exampleId}">${frames.map(({ stepId, explanation, codeLines }) => `<li data-practice-step="${stepId}"><p data-practice-explanation>${explanation}</p>${codeLines.map((line) => `<a data-practice-step-line="${line}">${line}</a>`).join("")}</li>`).join("")}</ol>`).join("")}
</section>
<footer style="height: 100vh">End of fixture</footer>
<script type="module">
  import { mountTracePlayer } from "/player.js";
  mountTracePlayer(document.querySelector("#player"));
</script>`;

const fixtureScripts = new Map<string, string>();

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(
          new URL("../../../src/client/practice/player.ts", import.meta.url),
        ),
        formats: ["es"],
      },
      rolldownOptions: { output: { entryFileNames: "player.js" } },
    },
  });
  const bundle = Array.isArray(output) ? output[0] : output;
  if (!bundle || !("output" in bundle))
    throw new Error("Expected one fixture bundle");
  for (const script of bundle.output)
    if (script.type === "chunk")
      fixtureScripts.set("/" + script.fileName, script.code);
  if (fixtureScripts.size < 2) throw new Error("Expected a lazy trace chunk");
});

test.beforeEach(async ({ page }) => {
  await page.route(origin + "/", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
  for (const [path, body] of fixtureScripts)
    await page.route(origin + path, (route) =>
      route.fulfill({ contentType: "text/javascript", body }),
    );
  await page.route(origin + tracePath, (route) =>
    route.fulfill({ contentType: "application/json", body: payload }),
  );
});

function step(page: Page) {
  return page.locator("[data-player-step]");
}

test("recovers from a stalled trace module download", async ({ page }) => {
  const modulePath = [...fixtureScripts.keys()].find(
    (path) => path !== "/player.js",
  )!;
  await page.route(origin + modulePath, () => {});
  await page.goto(origin);
  const load = page.getByRole("button", { name: "Load interactive trace" });
  await load.click();
  await expect(page.getByRole("status")).toContainText("took too long", {
    timeout: 7_000,
  });
  await expect(load).toBeEnabled();
  await expect(page.locator("[data-practice-step]").first()).toBeVisible();
});

test("loads on keyboard activation and keeps focus during setup and stepping", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/practice-traces/"))
      requests.push(request.url());
  });
  await page.goto(origin);
  const load = page.getByRole("button", { name: "Load interactive trace" });
  await expect(load).toBeVisible();
  expect(requests).toEqual([]);
  await load.focus();
  await load.press("Enter");
  const example = page.getByLabel("Example");
  await expect(example).toBeFocused();
  await expect(step(page)).toHaveText("Step 1 of 4");
  expect(requests).toEqual([origin + tracePath]);
  await expect(
    page.locator("[data-player-state] .trace-highlight"),
  ).toContainText("word-0");
  await expect(page.locator("[data-player-state]")).toContainText(
    "<b>text</b>",
  );
  await expect(page.locator("[data-player-state] b")).toHaveCount(0);
  const next = page.getByRole("button", { name: "Next" });
  await next.press("Space");
  await expect(next).toBeFocused();
  await expect(step(page)).toHaveText("Step 2 of 4");
  await expect(page.locator("[aria-current=step]")).toHaveAttribute(
    "data-practice-step",
    "queue-1",
  );
  await expect(page.locator(".trace-current-line")).toHaveText("second line");
  await page.getByRole("button", { name: "Previous" }).press("Enter");
  await expect(step(page)).toHaveText("Step 1 of 4");
  await example.selectOption("graph");
  await expect(step(page)).toHaveText("Step 1 of 1");
  await expect(page.locator(".trace-current-line")).toHaveCount(2);
  await expect(
    page.locator("[data-player-state] .trace-highlight"),
  ).toHaveCount(2);
  await example.selectOption("queue");
  await next.press("Enter");
  await page.getByRole("button", { name: "Reset" }).press("Enter");
  await expect(step(page)).toHaveText("Step 1 of 4");
});

test("applies speed, pauses on scroll and page hide, and resumes only on request", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(origin);
  await page.getByRole("button", { name: "Load interactive trace" }).click();
  await page.getByLabel("Speed").selectOption("2");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.getByRole("button", { name: "Previous" }).press("Enter");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.clock.runFor(550);
  await expect(step(page)).toHaveText("Step 2 of 4");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByRole("button", { name: "Play" })).toBeAttached();
  await page.clock.runFor(1_000);
  await expect(step(page)).toHaveText("Step 2 of 4");
  await page.getByRole("button", { name: "Play" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(step(page)).toHaveText("Step 2 of 4");
});

test.describe("touch with reduced motion", () => {
  test.use({
    hasTouch: true,
    viewport: { width: 390, height: 740 },
    reducedMotion: "reduce",
  });
  test("keeps manual playback available with automatic playback disabled", async ({
    page,
  }) => {
    await page.goto(origin);
    await page.getByRole("button", { name: "Load interactive trace" }).tap();
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
    await expect(page.locator("[data-player-motion-note]")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).tap();
    await expect(step(page)).toHaveText("Step 2 of 4");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
    await page.getByRole("button", { name: "Play" }).tap();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  });
});

test("reports corrupt or stalled responses while leaving the transcript and retry available", async ({
  page,
}) => {
  let attempt = 0;
  await page.route(origin + tracePath, (route) => {
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        contentType: "application/json",
        body: payload.replace("word-0", "word-9"),
      });
    if (attempt === 3)
      return route.fulfill({ contentType: "application/json", body: payload });
  });
  await page.goto(origin);
  const load = page.getByRole("button", { name: "Load interactive trace" });
  await load.click();
  await expect(page.getByRole("status")).toContainText("Could not load");
  await expect(
    page.getByText("Visit queue position 0.", { exact: true }),
  ).toBeVisible();
  await expect(load).toBeFocused();
  await load.press("Enter");
  await expect(page.getByRole("status")).toContainText("took too long", {
    timeout: 8_000,
  });
  await expect(
    page.getByText("Visit queue position 0.", { exact: true }),
  ).toBeVisible();
  await load.press("Enter");
  await expect(step(page)).toHaveText("Step 1 of 4");
});
