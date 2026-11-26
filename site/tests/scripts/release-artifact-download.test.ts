import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { readReleaseArtifactArchive } from "../../scripts/release-artifact-download.ts";
import { createGitHubArchiveReader } from "../../scripts/release-artifact-transport.ts";

const archive = Buffer.from(
  "UEsDBBQAAAAAAAAAIQCLntnTAQAAAAEAAAAKAAAAaW5kZXguaHRtbEFQSwECFAMUAAAAAAAAACEAi57Z0wEAAAABAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAApAAAAAAA=",
  "base64",
);
const receipt = {
  portfolioSha: "a".repeat(40),
  archiveSha256:
    "a51d27f838e810354555e6127268e74a275eb3dc3805678a3ae1f297f0c8fe3d",
  runId: 42,
  runAttempt: 2,
  artifactId: 17,
};
const metadataEndpoint =
  "https://api.github.com/repos/angadsinghsandhu/angadsinghsandhu/actions/artifacts/17";
const metadata = {
  id: 17,
  name: "portfolio-candidate-42-2",
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  digest: "sha256:" + receipt.archiveSha256,
  workflow_run: {
    id: 42,
    repository_id: 339077137,
    head_repository_id: 339077137,
    head_branch: "main",
    head_sha: receipt.portfolioSha,
  },
};

function transport(payload: unknown = metadata) {
  return {
    api: {
      token: "fixture-token",
      http: vi.fn<typeof fetch>().mockImplementation(async (url) => {
        expect(url).toBe(metadataEndpoint);
        return Response.json(payload);
      }),
    },
    readArchive: vi.fn(async (id: number) => {
      expect(id).toBe(17);
      return archive;
    }),
  };
}

it("retrieves the receipt-bound bytes by exact artifact ID", async () => {
  const reader = transport();
  await expect(readReleaseArtifactArchive(receipt, reader)).resolves.toEqual(
    archive,
  );
  expect(reader.api.http).toHaveBeenCalledTimes(1);
  expect(reader.readArchive).toHaveBeenCalledExactlyOnceWith(17);
});

it.each([
  { id: 16 },
  { name: "portfolio-candidate-42-1" },
  { digest: "sha256:" + "b".repeat(64) },
  { expired: true },
  { expires_at: "2000-01-01T00:00:00Z" },
  { workflow_run: { ...metadata.workflow_run, id: 43 } },
  { workflow_run: { ...metadata.workflow_run, repository_id: 2 } },
  { workflow_run: { ...metadata.workflow_run, head_repository_id: 2 } },
  { workflow_run: { ...metadata.workflow_run, head_branch: "other" } },
  { workflow_run: { ...metadata.workflow_run, head_sha: "b".repeat(40) } },
])(
  "rejects mismatched or expired metadata before retrieving bytes (%j)",
  async (change) => {
    const reader = transport({ ...metadata, ...change });
    await expect(readReleaseArtifactArchive(receipt, reader)).rejects.toThrow(
      /artifact proof/u,
    );
    expect(reader.readArchive).not.toHaveBeenCalled();
  },
);

it("rejects unsafe artifact IDs before reading metadata", async () => {
  const reader = transport();
  await expect(
    readReleaseArtifactArchive({ ...receipt, artifactId: -1 }, reader),
  ).rejects.toThrow();
  expect(reader.api.http).not.toHaveBeenCalled();
  expect(reader.readArchive).not.toHaveBeenCalled();
});

it("rejects altered archive bytes even when GitHub metadata has the expected digest", async () => {
  const reader = transport();
  const altered = Buffer.from(archive);
  altered[40] ^= 1;
  reader.readArchive.mockResolvedValue(altered);
  await expect(readReleaseArtifactArchive(receipt, reader)).rejects.toThrow(
    /archive digest/u,
  );
});

it("keeps verified bytes intact when the reader reuses its buffer", async () => {
  const reader = transport();
  const buffer = Buffer.from(archive);
  reader.readArchive.mockResolvedValue(buffer);
  const checked = await readReleaseArtifactArchive(receipt, reader);
  buffer[40] ^= 1;
  expect(checked).toEqual(archive);
});

it.each(["original", "altered"])(
  "checks exact authenticated metadata and verifies %s bytes through the ZIP transport",
  async (bytes) => {
    const payload = Buffer.from(archive);
    if (bytes === "altered") payload[40] ^= 1;
    const zipEndpoint = metadataEndpoint + "/zip";
    const signedEndpoint = "https://archive.example.test/signed?sig=fixture";
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      requests.push([
        request.method,
        request.url,
        request.headers.authorization,
      ]);
      switch (request.url) {
        case "/metadata":
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(metadata));
          break;
        case "/zip":
          response.writeHead(302, { location: signedEndpoint }).end();
          break;
        case "/signed?sig=fixture":
          response.setHeader("content-length", payload.byteLength);
          response.end(payload);
          break;
        default:
          response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing listener");
      const endpoints = new Map([
        [metadataEndpoint, "/metadata"],
        [zipEndpoint, "/zip"],
        [signedEndpoint, "/signed?sig=fixture"],
      ]);
      const api = {
        token: "fixture-token",
        http: ((input, init) => {
          const path = endpoints.get(String(input));
          if (!path) throw new Error("Unexpected archive test request");
          return fetch("http://127.0.0.1:" + address.port + path, init);
        }) satisfies typeof fetch,
      };
      const result = readReleaseArtifactArchive(receipt, {
        api,
        readArchive: createGitHubArchiveReader(api),
      });
      if (bytes === "original") await expect(result).resolves.toEqual(archive);
      else await expect(result).rejects.toThrow(/archive digest/u);
      expect(requests).toEqual([
        ["GET", "/metadata", "Bearer fixture-token"],
        ["GET", "/zip", "Bearer fixture-token"],
        ["GET", "/signed?sig=fixture", undefined],
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
