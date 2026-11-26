import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const identity = {
  origin: "https://portfolio.example",
  portfolioSha: "a".repeat(40),
  notesSha: "b".repeat(40),
  runId: 123,
  runAttempt: 2,
};

it("encodes fixed, versioned bytes from validated candidate identity", async () => {
  const { encodeReleaseMarker } =
    await import("../../scripts/release-build-marker.ts");
  expect(
    encodeReleaseMarker({
      ...identity,
      origin: "https://PORTFOLIO.example:443/",
    }).toString(),
  ).toBe(
    '{"version":1,"origin":"https://portfolio.example","portfolioSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","notesSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runId":123,"runAttempt":2}\n',
  );
  for (const invalid of [
    { ...identity, origin: "http://portfolio.example" },
    { ...identity, origin: "https://user@portfolio.example" },
    { ...identity, origin: "https://portfolio.example/path" },
    { ...identity, portfolioSha: identity.portfolioSha.toUpperCase() },
    { ...identity, notesSha: identity.notesSha + "\n" },
    { ...identity, runId: Number.MAX_SAFE_INTEGER + 1 },
    { ...identity, runAttempt: 0 },
    { ...identity, runAttempt: "2" },
    { ...identity, extra: true },
  ])
    expect(() => encodeReleaseMarker(invalid)).toThrow();
});

it("requires exact staged bytes and reserves the filename exclusively", async () => {
  const { releaseMarkerPath, writeReleaseMarker, verifyReleaseMarker } =
    await import("../../scripts/release-build-marker.ts");
  const directory = await mkdtemp(join(tmpdir(), "portfolio-marker-"));
  const file = join(directory, releaseMarkerPath);
  try {
    await expect(verifyReleaseMarker(directory, identity)).rejects.toThrow();
    await writeReleaseMarker(directory, identity);
    await expect(
      writeReleaseMarker(directory, { ...identity, runAttempt: 3 }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const bytes = await verifyReleaseMarker(directory, identity);
    await expect(
      verifyReleaseMarker(directory, { ...identity, runAttempt: 3 }),
    ).rejects.toThrow();
    await writeFile(file, String(bytes).trimEnd());
    await expect(verifyReleaseMarker(directory, identity)).rejects.toThrow();
    await writeFile(file, "{");
    await expect(verifyReleaseMarker(directory, identity)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("probes the canonical origin with a fresh, credential-free, bounded GET", async () => {
  const { encodeReleaseMarker, probeReleaseMarker } =
    await import("../../scripts/release-build-marker.ts");
  const prior = { ...identity, runAttempt: 1 };
  const fetchMarker = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(encodeReleaseMarker(identity).toString()),
    )
    .mockResolvedValueOnce(new Response(encodeReleaseMarker(prior).toString()))
    .mockResolvedValueOnce(
      new Response(
        encodeReleaseMarker({ ...identity, runAttempt: 3 }).toString(),
      ),
    )
    .mockResolvedValueOnce(
      new Response(encodeReleaseMarker(identity).toString() + "x".repeat(4096)),
    )
    .mockResolvedValueOnce(
      new Response(encodeReleaseMarker(identity).toString(), { status: 404 }),
    )
    .mockResolvedValueOnce(Response.redirect("https://elsewhere.example"))
    .mockRejectedValueOnce(new Error("offline"));
  for (const expected of [
    "selected",
    "prior",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]) {
    await expect(
      probeReleaseMarker(identity, prior, fetchMarker),
    ).resolves.toBe(expected);
  }
  const urls = fetchMarker.mock.calls.map(([input, options]) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(identity.origin);
    expect(url.pathname).toBe("/portfolio-release.json");
    expect(url.searchParams.get("probe")).toBeTruthy();
    expect(options).toEqual({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    return url.href;
  });
  expect(new Set(urls).size).toBe(urls.length);
});

it("bounds streamed reads with the same deadline as the GET", async () => {
  const { probeReleaseMarker } =
    await import("../../scripts/release-build-marker.ts");
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(controller.signal);
  try {
    const fetchMarker = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Response(
          new ReadableStream({
            start(stream) {
              options?.signal?.addEventListener(
                "abort",
                () => stream.error(new Error("deadline")),
                { once: true },
              );
            },
          }),
        ),
    );
    const read = probeReleaseMarker(identity, null, fetchMarker);
    controller.abort();
    await expect(read).resolves.toBe("unknown");
    expect(timeout).toHaveBeenCalledWith(10_000);
  } finally {
    timeout.mockRestore();
  }
});

it("adds the release marker before verifying and uploading the candidate", () => {
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/portfolio-release.yml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(workflow).toMatch(
    /npm run build:release\n\s+node scripts\/release-build-marker\.ts\n\s+npm run verify:output -- --dir dist --release-marker[\s\S]*actions\/upload-artifact@/,
  );
  expect(
    workflow.match(
      /- name: Verify combined Portfolio and Notes\n([\s\S]*?)run: \|/,
    )?.[1],
  ).toContain("PORTFOLIO_SHA: ${{ needs.select.outputs.portfolio_sha }}");
});
