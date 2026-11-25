import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { outputOrigin } from "./notes-redirects.ts";

export const releaseMarkerPath = "portfolio-release.json";

const sha = z.string().regex(/^[a-f0-9]{40}(?![\s\S])/u);
const id = z.number().int().positive();
const identity = z.strictObject({
  origin: z.string(),
  portfolioSha: sha,
  notesSha: sha,
  runId: id,
  runAttempt: id,
});
type ReleaseMarkerIdentity = z.input<typeof identity>;

export function encodeReleaseMarker(input: unknown): Buffer {
  const { origin, portfolioSha, notesSha, runId, runAttempt } =
    identity.parse(input);
  return Buffer.from(
    JSON.stringify({
      version: 1,
      origin: outputOrigin(origin),
      portfolioSha,
      notesSha,
      runId,
      runAttempt,
    }) + "\n",
  );
}

export async function writeReleaseMarker(
  directory: string,
  input: ReleaseMarkerIdentity,
): Promise<void> {
  await writeFile(
    join(directory, releaseMarkerPath),
    encodeReleaseMarker(input),
    {
      flag: "wx",
    },
  );
}

export async function verifyReleaseMarker(
  directory: string,
  input: ReleaseMarkerIdentity,
): Promise<Buffer> {
  const expected = encodeReleaseMarker(input);
  const actual = await readFile(join(directory, releaseMarkerPath));
  if (!actual.equals(expected))
    throw new Error("Staged release marker differs from the expected bytes");
  return expected;
}

export async function probeReleaseMarker(
  selected: ReleaseMarkerIdentity,
  prior: ReleaseMarkerIdentity | null,
  fetchMarker: typeof fetch = fetch,
): Promise<"selected" | "prior" | "unknown"> {
  const expected = encodeReleaseMarker(selected);
  const origin = outputOrigin(selected.origin);
  const previous =
    prior && outputOrigin(prior.origin) === origin
      ? encodeReleaseMarker(prior)
      : null;
  const url = new URL(releaseMarkerPath, origin);
  url.searchParams.set("probe", randomUUID());

  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchMarker(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (response.status !== 200 || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => {});
      return "unknown";
    }

    const bytes = Buffer.alloc(
      Math.max(expected.length, previous?.length ?? 0),
    );
    let length = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > bytes.length) {
          void reader.cancel().catch(() => {});
          return "unknown";
        }
        bytes.set(value, length);
        length += value.length;
      }
    } finally {
      reader.releaseLock();
    }

    signal.throwIfAborted();
    const actual = bytes.subarray(0, length);
    if (actual.equals(expected)) return "selected";
    if (previous?.equals(actual)) return "prior";
  } catch {
    return "unknown";
  }
  return "unknown";
}

if (import.meta.main) {
  const envId = z
    .string()
    .regex(/^[1-9][0-9]*(?![\s\S])/u)
    .transform(Number)
    .pipe(id);
  const env = process.env;
  await writeReleaseMarker("dist", {
    origin: env.PORTFOLIO_ORIGIN ?? "",
    portfolioSha: env.PORTFOLIO_SHA ?? "",
    notesSha: env.NOTES_REVISION ?? "",
    runId: envId.parse(env.GITHUB_RUN_ID),
    runAttempt: envId.parse(env.GITHUB_RUN_ATTEMPT),
  });
}
