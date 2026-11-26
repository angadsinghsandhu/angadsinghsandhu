import { expect, it, vi } from "vitest";
import { createReleaseSmoke } from "../../scripts/release-smoke.ts";

const origin = "https://portfolio.example";
const pdf =
  "/resources/classes/johns-hopkins/sem-1/ml-dl/mock-exams/cs482682-mock-exam-fall-2023-pdf/";
const asset = "/content-assets/" + "a".repeat(64) + ".pdf";
const legacy = { path: "/old.html", target: "/library/" };

function reader(overrides: Record<string, Response> = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (Object.hasOwn(overrides, url.pathname)) return overrides[url.pathname]!;
    if (url.pathname === legacy.path)
      return new Response(null, {
        status: 308,
        headers: { Location: legacy.target },
      });
    if (url.pathname === asset)
      return new Response("%PDF-1.7", {
        headers: { "Content-Type": "application/pdf" },
      });
    if (url.pathname === "/pagefind/pagefind-entry.json")
      return Response.json({
        languages: { en: { hash: "en_1d4cc63cd3", page_count: 1 } },
      });
    if (url.pathname === "/pagefind/pagefind.en_1d4cc63cd3.pf_meta")
      return new Response(Uint8Array.of(0x1f, 0x8b, 0x08));
    if (url.pathname === "/pagefind/pagefind.js")
      return new Response("export {}", {
        headers: { "Content-Type": "text/javascript" },
      });
    const canonical = `<link rel="canonical" href="${url.href}">`;
    return new Response(
      canonical +
        (url.pathname === pdf
          ? `<div data-pdf-url="${asset}"></div>`
          : "<main>Portfolio</main>"),
      { headers: { "Content-Type": "text/html" } },
    );
  });
}

it("checks the canonical navigation, search runtime, PDF bytes and explicit legacy mapping", async () => {
  const http = reader();
  await expect(createReleaseSmoke(origin, legacy, http)()).resolves.toBe(true);
  const paths = http.mock.calls.map(([url, options]) => {
    expect(new URL(String(url)).origin).toBe(origin);
    expect(options).toMatchObject({
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    return new URL(String(url)).pathname;
  });
  expect(paths).toEqual(
    expect.arrayContaining([
      "/",
      "/library/",
      "/interview/",
      "/search/",
      pdf,
      asset,
      "/pagefind/pagefind.js",
      "/pagefind/pagefind-entry.json",
      "/pagefind/pagefind.en_1d4cc63cd3.pf_meta",
      legacy.path,
    ]),
  );
});

it.each([
  ["/", () => Response.redirect(origin + "/library/", 308)],
  ["/search/", () => new Response("wrong", { status: 404 })],
  ["/pagefind/pagefind-entry.json", () => Response.json({ languages: {} })],
  [
    asset,
    () =>
      new Response("bogus", { headers: { "Content-Type": "application/pdf" } }),
  ],
  [
    pdf,
    () =>
      new Response(
        `<link rel="canonical" href="${origin}${pdf}"><div data-pdf-url="https://other.example${asset}"></div>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  ],
  [legacy.path, () => Response.redirect("https://other.example/library/", 308)],
])("rejects an invalid response at %s", async (path, response) => {
  const http = reader({ [path]: response() });
  await expect(createReleaseSmoke(origin, legacy, http)()).resolves.toBe(false);
});

it("cancels a streamed response above the bounded navigation body size", async () => {
  const cancel = vi.fn();
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(
    createReleaseSmoke(
      origin,
      undefined,
      reader({
        "/": new Response(oversized, {
          headers: { "Content-Type": "text/html" },
        }),
      }),
    )(),
  ).resolves.toBe(false);
  expect(cancel).toHaveBeenCalled();
});

it("rejects a PDF signature with the high bit set on each byte", async () => {
  const http = reader({
    [asset]: new Response(Uint8Array.of(0xa5, 0xd0, 0xc4, 0xc6, 0xad), {
      headers: { "Content-Type": "application/pdf" },
    }),
  });
  await expect(createReleaseSmoke(origin, undefined, http)()).resolves.toBe(
    false,
  );
});
