import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReleaseStage } from "../../scripts/stage-release-candidate.ts";

const origin = "https://portfolio.example";
const receipt = {
  portfolioSha: "a".repeat(40),
  notesSha: "b".repeat(40),
  runId: 11,
  runAttempt: 2,
  artifactId: 17,
  manifestSha256: "c".repeat(64),
  snapshotSchema: 1,
};
const marker =
  JSON.stringify({
    version: 1,
    origin,
    portfolioSha: receipt.portfolioSha,
    notesSha: receipt.notesSha,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
  }) + "\n";
const pythonExecutable = execFileSync(
  "python3",
  ["-c", "import sys; print(sys.executable)"],
  {
    encoding: "utf8",
    timeout: 10_000,
  },
).trim();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "stage-release-test-"));
  await writeFile(join(root, "unrelated"), "keep");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function archive(markerBytes: string) {
  return execFileSync(
    pythonExecutable,
    [
      "-c",
      `
import sys, zipfile
with zipfile.ZipFile(sys.stdout.buffer, "w") as output:
    output.writestr("index.html", "fixture index")
    output.writestr("portfolio-release.json", sys.argv[1])
`,
      markerBytes,
    ],
    { timeout: 10_000 },
  );
}

function fixture(bytes: Buffer) {
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        id: receipt.artifactId,
        name: "portfolio-candidate-11-2",
        expired: false,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        digest: "sha256:" + archiveSha256,
        workflow_run: {
          id: receipt.runId,
          repository_id: 339077137,
          head_repository_id: 339077137,
          head_branch: "main",
          head_sha: receipt.portfolioSha,
        },
      }),
    )
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://archive.example.test/release.zip?sig=fixture",
        },
      }),
    )
    .mockResolvedValueOnce(new Response(Uint8Array.from(bytes)));
  return {
    input: { ...receipt, archiveSha256 },
    config: {
      api: { token: "fixture-token", http },
      scratchParent: root,
      pythonExecutable,
      executable: process.execPath,
      origin,
    },
    http,
  };
}

it("passes a verified static tree from private scratch and preserves the callback result", async () => {
  const { config, input } = fixture(archive(marker));
  const result = { accepted: true };
  await expect(
    createReleaseStage(config)(input, async ({ directory, executable }) => {
      expect(dirname(dirname(directory))).toBe(root);
      expect((await stat(dirname(directory))).mode & 0o777).toBe(0o700);
      expect(await readFile(join(directory, "index.html"), "utf8")).toBe(
        "fixture index",
      );
      expect(executable).toBe(process.execPath);
      return result;
    }),
  ).resolves.toBe(result);
  expect(await readdir(root)).toEqual(["unrelated"]);
});

it.each([
  ["non-canonical scratch", () => archive(marker), "/."],
  ["invalid ZIP", () => Buffer.from("invalid"), ""],
  [
    "wrong marker",
    () => archive(marker.replace(origin, "https://other.example")),
    "",
  ],
] as const)(
  "rejects %s before invoking the callback",
  async (_label, bytes, suffix) => {
    const { config, input, http } = fixture(bytes());
    const callback = vi.fn();
    await expect(
      createReleaseStage({ ...config, scratchParent: root + suffix })(
        input,
        callback,
      ),
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(suffix ? 0 : 3);
    expect(await readdir(root)).toEqual(["unrelated"]);
  },
);

it("removes private scratch when the callback rejects", async () => {
  const { config, input } = fixture(archive(marker));
  const failure = new Error("callback failed");
  await expect(
    createReleaseStage(config)(input, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await readFile(join(root, "unrelated"), "utf8")).toBe("keep");
  expect(await readdir(root)).toEqual(["unrelated"]);
});
