import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readReleaseArtifactProof } from "../../scripts/release-artifact-proof.ts";
import {
  importNotesSnapshot,
  notesSnapshotDirectory,
} from "../../src/lib/notes-snapshot.ts";
import { readPracticeBundleProof } from "../../scripts/verify-practice-bundle.ts";
import { portfolioSnapshotV1 } from "../../src/lib/notes-snapshot-v1.ts";
import fixture from "../fixtures/notes-snapshot/manifest.v1.json" with { type: "json" };

const upload = {
  portfolioSha: "b".repeat(40),
  notesSha: fixture.sourceSha,
  runId: "45294310968",
  runAttempt: "2",
  artifactId: "989824924",
  archiveSha256: "c".repeat(64),
};
const artifact = {
  id: 989824924,
  name: "portfolio-candidate-45294310968-2",
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  digest: "sha256:" + upload.archiveSha256,
  workflow_run: {
    id: 45294310968,
    repository_id: 339077137,
    head_repository_id: 339077137,
    head_branch: "main",
    head_sha: upload.portfolioSha,
  },
};
const manifest = JSON.stringify({ ...fixture, mode: "production" });
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
const artifactEndpoint =
  "https://api.github.com/repos/angadsinghsandhu/angadsinghsandhu/actions/artifacts/989824924";

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "portfolio-artifact-proof-"));
  const source = join(directory, "snapshot");
  mkdirSync(join(source, "assets"), { recursive: true });
  mkdirSync(join(source, "worker-assets/practice-traces"), { recursive: true });
  writeFileSync(join(source, "manifest.json"), manifest);
  const receipt = join(directory, "notes-export-receipt.json");
  writeFileSync(
    receipt,
    JSON.stringify({
      mode: "production",
      sourceSha: upload.notesSha,
      manifestSha256,
    }),
  );
  await importNotesSnapshot(
    source,
    join(directory, notesSnapshotDirectory),
    upload.notesSha,
    receipt,
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function fakeGitHub(payload: unknown) {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      payload instanceof Response ? payload : Response.json(payload),
    );
  return { token: "read-only-token", http };
}

it("binds the uploaded archive and validated production snapshot to the same release receipt", async () => {
  const api = fakeGitHub(artifact);
  await expect(
    readReleaseArtifactProof(
      upload,
      join(directory, notesSnapshotDirectory),
      api,
    ),
  ).resolves.toEqual({
    ...upload,
    artifactId: artifact.id,
    runId: artifact.workflow_run.id,
    runAttempt: 2,
    snapshotSchema: 1,
    manifestSha256,
  });
  expect(api.http).toHaveBeenCalledExactlyOnceWith(artifactEndpoint, {
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer read-only-token",
    },
  });
});

it.each([
  ["artifact ID", { id: artifact.id + 1 }],
  ["different attempt", { name: "portfolio-candidate-45294310968-1" }],
  ["different digest", { digest: "sha256:" + "d".repeat(64) }],
  ["missing digest", { digest: undefined }],
  ["expired marker", { expired: true }],
  ["elapsed expiration", { expires_at: "2020-01-01T00:00:00Z" }],
  ["different run", { workflow_run: { ...artifact.workflow_run, id: 2 } }],
  [
    "different repository",
    { workflow_run: { ...artifact.workflow_run, repository_id: 1 } },
  ],
  [
    "different head repository",
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 1 } },
  ],
  [
    "different Portfolio SHA",
    { workflow_run: { ...artifact.workflow_run, head_sha: upload.notesSha } },
  ],
  [
    "different Portfolio branch",
    { workflow_run: { ...artifact.workflow_run, head_branch: "topic" } },
  ],
])("rejects artifact proof with %s", async (_reason, changed) => {
  await expect(
    readReleaseArtifactProof(
      upload,
      join(directory, notesSnapshotDirectory),
      fakeGitHub({ ...artifact, ...changed }),
    ),
  ).rejects.toThrow(/artifact proof/i);
});

it("rejects GitHub errors and redirects", async () => {
  await expect(
    readReleaseArtifactProof(
      upload,
      join(directory, notesSnapshotDirectory),
      fakeGitHub(new Response(null, { status: 302 })),
    ),
  ).rejects.toThrow(/artifact proof/i);
});

it("rejects a selected Notes SHA different from the validated snapshot before reading GitHub", async () => {
  const api = fakeGitHub(artifact);
  await expect(
    readReleaseArtifactProof(
      { ...upload, notesSha: upload.portfolioSha },
      join(directory, notesSnapshotDirectory),
      api,
    ),
  ).rejects.toThrow(/Notes.*revision/i);
  expect(api.http).not.toHaveBeenCalled();
});

it.each([
  ["artifactId", "3/zip"],
  ["runId", "9007199254740993"],
  ["runAttempt", "02"],
  ["archiveSha256", "missing"],
] as const)(
  "rejects malformed workflow input %s before reading GitHub",
  async (field, value) => {
    const api = fakeGitHub(artifact);
    await expect(
      readReleaseArtifactProof(
        { ...upload, [field]: value },
        join(directory, notesSnapshotDirectory),
        api,
      ),
    ).rejects.toThrow();
    expect(api.http).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "runs the receipt CLI against artifact metadata (match: %s)",
  (matching) => {
    const output = join(directory, "output");
    const payload = matching ? artifact : { ...artifact, expired: true };
    // Stub the HTTPS read in the child process while exercising the real CLI and snapshot loader.
    const preload = `
    globalThis.fetch = async (url) => {
      if (url !== ${JSON.stringify(artifactEndpoint)}) process.exit(2);
      return Response.json(${JSON.stringify(payload)});
    };
  `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript," + encodeURIComponent(preload),
        fileURLToPath(
          new URL("../../scripts/release-artifact-proof.ts", import.meta.url),
        ),
      ],
      {
        cwd: directory,
        env: {
          GITHUB_RUN_ID: upload.runId,
          GITHUB_RUN_ATTEMPT: upload.runAttempt,
          GITHUB_OUTPUT: output,
          PORTFOLIO_SHA: upload.portfolioSha,
          NOTES_REVISION: upload.notesSha,
          CANDIDATE_ARTIFACT_ID: upload.artifactId,
          CANDIDATE_ARTIFACT_DIGEST: upload.archiveSha256,
          PORTFOLIO_ARTIFACT_TOKEN: "read-only-token",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(matching ? 0 : 1);
    if (!matching) {
      expect(existsSync(output)).toBe(false);
      return;
    }
    const line = readFileSync(output, "utf8");
    expect(line).toMatch(/^release_receipt=[^\n]+\n$/u);
    expect(JSON.parse(line.slice("release_receipt=".length))).toMatchObject({
      manifestSha256,
      artifactId: artifact.id,
    });
  },
);

it("exposes the separate receipt only after the immutable archive upload", () => {
  const workflow = readFileSync(
    new URL(
      "../../../.github/workflows/portfolio-release.yml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(workflow).toContain(
    "release_receipt: ${{ steps.receipt.outputs.release_receipt }}",
  );
  expect(workflow).toMatch(/\n {2}build:[\s\S]*?\n {6}actions: read\n/);
  expect(workflow).toMatch(
    /path: \$\{\{ steps\.verify\.outputs\.artifact_path \}\}\n[\s\S]*\n {8}id: receipt\n[\s\S]*\n {8}run: node scripts\/release-artifact-proof\.ts\n/,
  );
  expect(workflow).toContain("PORTFOLIO_ARTIFACT_TOKEN: ${{ github.token }}");
  expect(workflow).toContain(
    "CANDIDATE_ARTIFACT_ID: ${{ steps.candidate.outputs.artifact-id }}",
  );
  expect(workflow).toContain(
    "CANDIDATE_ARTIFACT_DIGEST: ${{ steps.candidate.outputs.artifact-digest }}",
  );
});

it("rejects pairing an arbitrary trace bundle with a zero-lesson production snapshot", async () => {
  const api = fakeGitHub(artifact);
  await expect(
    readReleaseArtifactProof(
      upload,
      join(directory, notesSnapshotDirectory),
      api,
      join(directory, "untrusted-pair"),
    ),
  ).rejects.toThrow(/paired artifact.*Notes snapshot/i);
  expect(api.http).not.toHaveBeenCalled();
});

it("rejects a Pages-only mutation after the paired output was certified", async () => {
  const workerBytes = '{"examples":[]}\n';
  const digest = createHash("sha256").update(workerBytes).digest("hex");
  const url = `/practice-traces/${digest}.json` as const;
  const workerPath = `worker-assets${url}`;
  const selected = portfolioSnapshotV1.parse({
    ...fixture,
    mode: "production",
  });
  selected.verifiedCurriculumIds = [1];
  selected.curriculum.generation = "1".repeat(64);
  selected.curriculum.problems.push({
    id: "leetcode:1",
    number: 1,
    slug: "two-sum",
    title: "Two Sum",
    officialUrl: "https://leetcode.com/problems/two-sum/",
    status: "verified",
    domain: "algorithm",
    topics: ["arrays"],
    companies: [],
    difficulty: "easy",
    officialQuestionObservedOn: "2026-11-23",
  });
  const trace = {
    url,
    sha256: digest,
    bytes: workerBytes.length,
    exampleIds: ["example"],
  };
  selected.curriculum.lessons.push({
    problemId: "leetcode:1",
    route: "/practice/leetcode/1/",
    status: "verified",
    bodyHtml: "<p>Worked example.</p>",
    headings: [],
    approaches: [
      {
        id: "hash",
        entryPoint: "solve",
        title: "Hash table",
        language: "python",
        implementationSha256: "2".repeat(64),
        codeHtml: "<pre>solve</pre>",
        trace,
        transcripts: [],
      },
    ],
  });
  selected.curriculum.traceAssets.push({
    publicPath: url,
    exportPath: workerPath,
    bytes: trace.bytes,
    sha256: digest,
  });
  const source = join(directory, "snapshot");
  const manifest = JSON.stringify(selected);
  const receiptPath = join(directory, "paired-snapshot.json");
  writeFileSync(join(source, "manifest.json"), manifest);
  writeFileSync(join(source, workerPath), workerBytes);
  writeFileSync(
    receiptPath,
    JSON.stringify({
      mode: "production",
      sourceSha: upload.notesSha,
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    }),
  );
  const store = join(directory, notesSnapshotDirectory);
  await importNotesSnapshot(source, store, upload.notesSha, receiptPath);
  const bundle = join(directory, "bundle");
  mkdirSync(join(bundle, "pages"), { recursive: true });
  mkdirSync(join(bundle, "worker-assets/practice-traces"), { recursive: true });
  writeFileSync(join(bundle, "pages/index.html"), "<p>Checked bytes.</p>");
  writeFileSync(join(bundle, workerPath), workerBytes);
  const proof = await readPracticeBundleProof(bundle);
  writeFileSync(bundle + ".proof.json", JSON.stringify(proof));

  await expect(
    readReleaseArtifactProof(upload, store, fakeGitHub(artifact), bundle),
  ).resolves.toMatchObject({ practice: proof });
  writeFileSync(join(bundle, "pages/index.html"), "<p>Different bytes.</p>");
  const api = fakeGitHub(artifact);
  await expect(
    readReleaseArtifactProof(upload, store, api, bundle),
  ).rejects.toThrow(/certified practice artifact/i);
  expect(api.http).not.toHaveBeenCalled();
});
