import {
  releaseArtifactIdentity,
  releaseArtifactPath,
} from "./release-artifact-download.ts";
import type { readGitHub } from "./release-source-proof.ts";

const maximumZipBytes = 1280 * 1024 * 1024;

async function request(
  http: typeof fetch,
  url: string | URL,
  init: RequestInit,
  failure: string,
): Promise<Response> {
  try {
    return await http(url, init);
  } catch {
    throw new Error(failure);
  }
}

function storageUrl(location: string | null): URL {
  const url =
    location &&
    /^https:\/\/[^/?#@]+(?:[/?]|$)/iu.test(location) &&
    !/[\\#\s\p{Cc}]/u.test(location) &&
    URL.parse(location);
  if (!url) {
    throw new Error("GitHub artifact archive redirect is invalid");
  }
  return url;
}

async function readZip(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub artifact archive is empty");

  try {
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity")
      throw new Error("GitHub artifact archive has unsupported HTTP encoding");

    const length = response.headers.get("content-length");
    const declared = length === null ? undefined : Number(length);
    if (length !== null && !/^\d+$/u.test(length))
      throw new Error("GitHub artifact archive has an invalid content length");
    if (declared !== undefined && declared > maximumZipBytes)
      throw new Error("GitHub artifact archive exceeds the ZIP size limit");

    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error("GitHub artifact archive storage body failed");
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumZipBytes)
        throw new Error("GitHub artifact archive exceeds the ZIP size limit");
      if (declared !== undefined && size > declared)
        throw new Error("GitHub artifact archive has the wrong content length");
      chunks.push(chunk.value);
    }
    if (size === 0) throw new Error("GitHub artifact archive is empty");
    if (declared !== undefined && size !== declared)
      throw new Error("GitHub artifact archive has the wrong content length");
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createGitHubArchiveReader({
  token,
  http = fetch,
}: Parameters<typeof readGitHub>[1]): (
  artifactId: number,
) => Promise<Uint8Array> {
  return async (artifactId) => {
    if (!releaseArtifactIdentity.shape.artifactId.safeParse(artifactId).success)
      throw new Error("GitHub artifact ID must be a positive safe integer");
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      /[^!-~]/u.test(token)
    )
      throw new Error("GitHub archive token is invalid");

    const redirect = await request(
      http,
      "https://api.github.com" + releaseArtifactPath + artifactId + "/zip",
      {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
        },
        signal: AbortSignal.timeout(15_000),
      },
      "GitHub artifact archive request failed",
    );
    void redirect.body?.cancel().catch(() => {});
    if (redirect.status === 410)
      throw new Error("GitHub artifact archive is gone");
    if (redirect.status !== 302)
      throw new Error("GitHub artifact archive request failed");

    const signedUrl = storageUrl(redirect.headers.get("location"));
    const archive = await request(
      http,
      signedUrl,
      {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(300_000),
      },
      "GitHub artifact archive storage request failed",
    );
    if (archive.status !== 200) {
      void archive.body?.cancel().catch(() => {});
      throw new Error("GitHub artifact archive storage request failed");
    }
    return readZip(archive);
  };
}
