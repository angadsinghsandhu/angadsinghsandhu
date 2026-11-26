import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("Cloudflare Pages receives a root 404 page with recovery links", () => {
  const html = readFileSync(
    new URL("../../public/404.html", import.meta.url),
    "utf8",
  );

  expect(html).toMatch(/<h1>Page not found<\/h1>/u);
  expect(html).toMatch(/name="robots" content="noindex"/u);
  expect(html).toMatch(/href="\/"/u);
  expect(html).toMatch(/href="\/library\/"/u);
});
