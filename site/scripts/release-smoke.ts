import { z } from "zod";
import { outputOrigin } from "./notes-redirects.ts";

const pdfRoute =
  "/resources/classes/johns-hopkins/sem-1/ml-dl/mock-exams/cs482682-mock-exam-fall-2023-pdf/";
const htmlLimit = 1024 * 1024;
const pathPattern = /^\/(?:[A-Za-z0-9_.%-]+\/)*[A-Za-z0-9_.%-]+\/?(?![\s\S])/u;
const searchEntry = z.object({
  languages: z.object({
    en: z.object({
      hash: z.string().regex(/^en_[a-f0-9]{10,64}(?![\s\S])/u),
      page_count: z.number().int().positive(),
    }),
  }),
});

type Legacy = { path: string; target: string };

function contentType(response: Response) {
  return response.headers.get("content-type")?.split(";")[0]?.toLowerCase();
}

async function readBytes(
  response: Response,
  limit: number,
  expected: (response: Response) => boolean,
  prefixOnly: boolean,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = response.body;
  if (
    !body ||
    response.redirected ||
    !expected(response) ||
    (!prefixOnly && Number(response.headers.get("content-length")) > limit)
  ) {
    void body?.cancel().catch(() => {});
    throw new Error("Unexpected smoke response");
  }

  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (!prefixOnly || size < limit) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!prefixOnly && size + value.length > limit)
        throw new Error("Smoke response exceeds its size limit");
      const chunk = prefixOnly ? value.subarray(0, limit - size) : value;
      chunks.push(chunk);
      size += chunk.length;
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createReleaseSmoke(
  configuredOrigin: string,
  legacy?: Legacy,
  http = fetch,
) {
  const origin = outputOrigin(configuredOrigin);
  if (legacy) {
    for (const path of [legacy.path, legacy.target]) {
      const url = new URL(path, origin);
      if (
        !pathPattern.test(path) ||
        url.origin !== origin ||
        url.pathname !== path
      )
        throw new Error(
          "Legacy smoke requires exact approved same-origin paths",
        );
    }
    if (legacy.path === legacy.target)
      throw new Error("Legacy smoke cannot redirect to itself");
  }

  function request(path: string, signal: AbortSignal, headers?: HeadersInit) {
    return http(new URL(path, origin), {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      signal,
      headers,
    });
  }

  async function bytes(
    path: string,
    limit: number,
    expected: (response: Response) => boolean,
    prefixOnly = false,
  ): Promise<Buffer> {
    const signal = AbortSignal.timeout(10_000);
    const response = await request(
      path,
      signal,
      prefixOnly ? { Range: `bytes=0-${limit - 1}` } : undefined,
    );
    return readBytes(response, limit, expected, prefixOnly, signal);
  }

  async function page(path: string): Promise<string> {
    const html = (
      await bytes(
        path,
        htmlLimit,
        (response) =>
          response.status === 200 && contentType(response) === "text/html",
      )
    ).toString("utf8");
    const canonical = /<link rel="canonical" href="([^"]+)"/u.exec(html)?.[1];
    if (canonical !== new URL(path, origin).href)
      throw new Error("Smoke page has the wrong canonical route");
    return html;
  }

  async function pdf() {
    const html = await page(pdfRoute);
    const path = /\bdata-pdf-url="(\/content-assets\/[a-f0-9]{64}\.pdf)"/u.exec(
      html,
    )?.[1];
    if (!path) return false;
    const prefix = await bytes(
      path,
      5,
      (response) =>
        (response.status === 200 || response.status === 206) &&
        contentType(response) === "application/pdf",
      true,
    );
    return prefix.equals(Buffer.from("%PDF-"));
  }

  async function search() {
    const [script, entry] = await Promise.all([
      bytes(
        "/pagefind/pagefind.js",
        256 * 1024,
        (response) =>
          response.status === 200 &&
          /^(?:text|application)\/javascript$/u.test(
            contentType(response) ?? "",
          ),
      ),
      bytes(
        "/pagefind/pagefind-entry.json",
        32 * 1024,
        (response) =>
          response.status === 200 &&
          contentType(response) === "application/json",
      ),
    ]);
    const parsed = searchEntry.parse(JSON.parse(entry.toString("utf8")));
    const index = await bytes(
      `/pagefind/pagefind.${parsed.languages.en.hash}.pf_meta`,
      1024 * 1024,
      (response) => response.status === 200,
    );
    return script.length > 0 && index[0] === 0x1f && index[1] === 0x8b;
  }

  async function redirect({ path, target }: Legacy) {
    const response = await request(path, AbortSignal.timeout(10_000));
    void response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (
      response.status !== 308 ||
      response.redirected ||
      !location ||
      URL.parse(location, new URL(path, origin))?.href !==
        new URL(target, origin).href
    )
      return false;
    await page(target);
    return true;
  }

  return async () => {
    try {
      const results = await Promise.all([
        ...["/", "/library/", "/interview/", "/search/"].map(page),
        pdf(),
        search(),
        legacy ? redirect(legacy) : true,
      ]);
      return results.every(Boolean);
    } catch {
      return false;
    }
  };
}
