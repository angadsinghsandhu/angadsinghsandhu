import { expect, it, vi } from "vitest";
import { createGitHubArchiveReader } from "../../scripts/release-artifact-transport.ts";

const token = "fixture-token";
const signedUrl =
  "https://archive.example.test/candidate.zip?sig=fixture-signature";

function redirect(location = signedUrl) {
  return new Response(null, { status: 302, headers: { location } });
}

function transport(...responses: Response[]) {
  const http = vi.fn<typeof fetch>();
  for (const response of responses) http.mockResolvedValueOnce(response);
  return { http, readArchive: createGitHubArchiveReader({ token, http }) };
}

it("requests an exact artifact ZIP and strips GitHub headers on the signed hop", async () => {
  const { http, readArchive } = transport(
    redirect(),
    new Response(Uint8Array.of(80, 75), { headers: { "content-length": "2" } }),
  );
  await expect(readArchive(17)).resolves.toEqual(Buffer.from([80, 75]));
  expect(http.mock.calls).toHaveLength(2);
  const [[apiUrl, api], [archiveUrl, archive]] = http.mock.calls;
  expect(String(apiUrl)).toBe(
    "https://api.github.com/repos/angadsinghsandhu/angadsinghsandhu/actions/artifacts/17/zip",
  );
  expect(api).toMatchObject({ method: "GET", redirect: "manual" });
  expect(new Headers(api?.headers).get("authorization")).toBe(
    "Bearer " + token,
  );
  expect(String(archiveUrl)).toBe(signedUrl);
  expect(archive).toMatchObject({
    method: "GET",
    redirect: "error",
    credentials: "omit",
  });
  expect([...new Headers(archive?.headers)]).toEqual([
    ["accept-encoding", "identity"],
  ]);
});

it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an unsafe artifact ID (%s) before making a request",
  async (id) => {
    const { http, readArchive } = transport();
    await expect(readArchive(id)).rejects.toThrow(/artifact ID/u);
    expect(http).not.toHaveBeenCalled();
  },
);

it.each(["", "fixture token", "fixture\u0000token"])(
  "rejects an invalid token before making a request",
  async (invalid) => {
    const http = vi.fn<typeof fetch>();
    const readArchive = createGitHubArchiveReader({ token: invalid, http });
    await expect(readArchive(17)).rejects.toThrow(/token/u);
    expect(http).not.toHaveBeenCalled();
  },
);

it.each([
  [200, /request failed/u],
  [301, /request failed/u],
  [404, /request failed/u],
  [410, /gone/u],
])("rejects an unsupported GitHub status (%s)", async (status, error) => {
  const { http, readArchive } = transport(
    new Response(null, { status, headers: { location: signedUrl } }),
  );
  await expect(readArchive(17)).rejects.toThrow(error);
  expect(http).toHaveBeenCalledTimes(1);
});

it.each([
  "",
  "/candidate.zip",
  "//archive.example.test/candidate.zip",
  "https:archive.example.test/candidate.zip",
  "http://archive.example.test/candidate.zip",
  "https://user:password@archive.example.test/candidate.zip",
  "https://@archive.example.test/candidate.zip",
  "https://:@archive.example.test/candidate.zip",
  "https://archive.example.test\\candidate.zip",
  "https://archive.example.test/candidate.zip#fragment",
  "https://[invalid]/candidate.zip",
])("rejects an invalid redirect location (%s)", async (location) => {
  const { http, readArchive } = transport(redirect(location));
  await expect(readArchive(17)).rejects.toThrow(/redirect is invalid/u);
  expect(http).toHaveBeenCalledTimes(1);
});

it("rejects a missing redirect location", async () => {
  const { http, readArchive } = transport(new Response(null, { status: 302 }));
  await expect(readArchive(17)).rejects.toThrow(/redirect is invalid/u);
  expect(http).toHaveBeenCalledTimes(1);
});

it.each([206, 302, 410])(
  "rejects an unsupported storage status (%s)",
  async (status) => {
    const { http, readArchive } = transport(
      redirect(),
      new Response(null, {
        status,
        headers: { location: "https://second.example.test/candidate.zip" },
      }),
    );
    await expect(readArchive(17)).rejects.toThrow(/storage request failed/u);
    expect(http).toHaveBeenCalledTimes(2);
  },
);

it.each([null, new Uint8Array(0)])(
  "rejects a missing or empty archive body",
  async (body) => {
    const { readArchive } = transport(redirect(), new Response(body));
    await expect(readArchive(17)).rejects.toThrow(/empty/u);
  },
);

it.each(["invalid", "1", "3"])(
  "rejects an invalid or mismatched declared size (%s)",
  async (length) => {
    const { readArchive } = transport(
      redirect(),
      new Response(Uint8Array.of(80, 75), {
        headers: { "content-length": length },
      }),
    );
    await expect(readArchive(17)).rejects.toThrow(/length/u);
  },
);

it("rejects a storage response that applies HTTP compression", async () => {
  const { readArchive } = transport(
    redirect(),
    new Response(Uint8Array.of(80, 75), {
      headers: { "content-encoding": "gzip" },
    }),
  );
  await expect(readArchive(17)).rejects.toThrow(/encoding/u);
});

it("cancels a declared size above the ZIP cap", async () => {
  const cancel = vi.fn();
  const { readArchive } = transport(
    redirect(),
    new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "1342177281" },
    }),
  );
  await expect(readArchive(17)).rejects.toThrow(/size limit/u);
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels an oversized stream without a content-length header", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const cancel = vi.fn();
  const { readArchive } = transport(
    redirect(),
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel,
      }),
    ),
  );
  await expect(readArchive(17)).rejects.toThrow(/size limit/u);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["api", "storage", "body"])(
  "sanitizes errors raised by the %s transport",
  async (stage) => {
    const secretError = new Error(token + " " + signedUrl);
    const body = new ReadableStream({
      pull(controller) {
        controller.error(secretError);
      },
    });
    const http = vi.fn<typeof fetch>();
    if (stage !== "api") http.mockResolvedValueOnce(redirect());
    if (stage === "body") http.mockResolvedValueOnce(new Response(body));
    else http.mockRejectedValueOnce(secretError);
    const readArchive = createGitHubArchiveReader({ token, http });
    const result = await readArchive(17).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty("cause");
    expect(result).not.toHaveProperty("stack", expect.stringContaining(token));
    expect(result).not.toHaveProperty(
      "stack",
      expect.stringContaining(signedUrl),
    );
  },
);

it("applies separate deadlines to the GitHub request and the storage body", async () => {
  const deadlines = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(AbortSignal.abort())
    .mockReturnValueOnce(new AbortController().signal);
  try {
    const { http, readArchive } = transport();
    http.mockImplementationOnce(async (_url, request) => {
      request?.signal?.throwIfAborted();
      return redirect();
    });
    await expect(readArchive(17)).rejects.toThrow(/request failed/u);
    expect(http).toHaveBeenCalledTimes(1);
    expect(deadlines).toHaveBeenNthCalledWith(1, 15_000);

    const storageDeadline = new AbortController();
    deadlines.mockReturnValueOnce(storageDeadline.signal);
    const fixture = transport(redirect());
    fixture.http.mockImplementationOnce(
      async (_url, request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              expect(request?.signal).toBe(storageDeadline.signal);
              request?.signal?.addEventListener("abort", () =>
                controller.error(new Error(signedUrl)),
              );
              storageDeadline.abort();
            },
          }),
        ),
    );
    await expect(fixture.readArchive(17)).rejects.toThrow(/storage body/u);
    expect(deadlines).toHaveBeenNthCalledWith(3, 300_000);
  } finally {
    deadlines.mockRestore();
  }
});
