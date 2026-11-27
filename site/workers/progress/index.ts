import { verifyAccess } from "./access.ts";
import {
  createProgressRepository,
  type ProgressDatabase,
  type ProgressRow,
} from "./repository.ts";

interface ProgressEnv {
  PROGRESS: ProgressDatabase;
  PRIVATE_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  ACCESS_OWNER_SUBJECT: string;
}

type ProgressChange = Parameters<
  ReturnType<typeof createProgressRepository>["save"]
>[1];

const maxBodyBytes = 1024;
const accountPath = "/account/";
const apiPath = "/api/progress/";
const exportPath = "/api/progress/export/";

function privateHeaders(headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return responseHeaders;
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers: privateHeaders(headers) });
}

function lessonNumber(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^leetcode:([1-9][0-9]{0,3})(?![\s\S])/u.exec(value);
  return match && Number(match[1]) <= 2000 ? match[1]! : null;
}

function parseProgressChange(input: unknown): ProgressChange | null {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).length !== 4 ||
    !("problemId" in input) ||
    !("studied" in input) ||
    !("lessonRevision" in input) ||
    !("expectedVersion" in input)
  )
    return null;

  const { problemId, studied, lessonRevision, expectedVersion } = input;
  if (
    typeof problemId !== "string" ||
    lessonNumber(problemId) === null ||
    typeof studied !== "boolean" ||
    typeof lessonRevision !== "string" ||
    !/^[a-f0-9]{64}(?![\s\S])/u.test(lessonRevision) ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )
    return null;

  return { problemId, studied, lessonRevision, expectedVersion };
}

async function readProgressChange(request: Request) {
  const contentType = request.headers.get("Content-Type");
  if (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  )
    return json({ error: "Expected application/json" }, 415);
  if (Number(request.headers.get("Content-Length")) > maxBodyBytes)
    return json({ error: "Progress update too large" }, 413);
  if (!request.body) return json({ error: "Invalid progress update" }, 400);

  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBodyBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return json({ error: "Progress update too large" }, 413);
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
    return (
      parseProgressChange(JSON.parse(text)) ??
      json({ error: "Invalid progress update" }, 400)
    );
  } catch {
    return json({ error: "Invalid progress update" }, 400);
  } finally {
    reader.releaseLock();
  }
}

function account(rows: ProgressRow[]) {
  const studied = rows
    .flatMap((row) => {
      const number = lessonNumber(row.problemId);
      return row.studied && number ? [number] : [];
    })
    .sort((a, b) => Number(a) - Number(b));
  const links = studied
    .map(
      (number) =>
        `<li><a href="/practice/leetcode/${number}/">LeetCode ${number}</a></li>`,
    )
    .join("");
  return new Response(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Study progress</title></head>
<body>
<main>
<h1>Study progress</h1>
<p>${studied.length} studied ${studied.length === 1 ? "lesson" : "lessons"}</p>
${links ? `<ul>${links}</ul>` : "<p>No lessons marked studied yet.</p>"}
<nav aria-label="Account actions">
<a href="/practice/leetcode/">Back to LeetCode practice</a>
<a href="/api/progress/export/">Download progress (JSON)</a>
<a href="/cdn-cgi/access/logout">Sign out</a>
</nav>
</main>
</body>
</html>`,
    {
      headers: privateHeaders({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      }),
    },
  );
}

export default {
  async fetch(request: Request, env: ProgressEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      url.protocol !== "https:" ||
      url.origin !== env.PRIVATE_ORIGIN ||
      (path !== apiPath && path !== exportPath && path !== accountPath)
    )
      return json({ error: "Not found" }, 404);

    const ownerId = await verifyAccess(request, {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      ownerSubject: env.ACCESS_OWNER_SUBJECT,
    }).catch(() => null);
    if (!ownerId || ownerId !== env.ACCESS_OWNER_SUBJECT)
      return json({ error: "Authentication required" }, 401);

    const writing = path === apiPath && request.method === "PUT";
    if (request.method !== "GET" && !writing)
      return json({ error: "Method not allowed" }, 405, {
        Allow: path === apiPath ? "GET, PUT" : "GET",
      });

    try {
      if (writing) {
        if (request.headers.get("Origin") !== url.origin)
          return json({ error: "A same-origin write is required" }, 403);
        const change = await readProgressChange(request);
        if (change instanceof Response) return change;
        const result = await createProgressRepository(env.PROGRESS).save(
          ownerId,
          change,
          Date.now(),
        );
        return json(
          { row: result.row },
          result.kind === "conflict" ? 409 : 200,
        );
      }

      const rows = await createProgressRepository(env.PROGRESS).list(ownerId);
      if (path === accountPath) return account(rows);
      const headers =
        path === exportPath
          ? {
              "Content-Disposition":
                'attachment; filename="portfolio-progress-v1.json"',
            }
          : undefined;
      return json({ version: 1, rows }, 200, headers);
    } catch {
      return json({ error: "Progress is temporarily unavailable" }, 503);
    }
  },
};
