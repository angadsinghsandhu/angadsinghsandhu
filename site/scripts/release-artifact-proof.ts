import { appendFile } from "node:fs/promises";
import { z } from "zod";
import {
  notesSnapshotDirectory,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";
import type { ReleaseReceipt } from "./release-policy.ts";
import { readGitHub } from "./release-source-proof.ts";

const portfolioRepositoryId = 339077137;
const artifactPath =
  "/repos/angadsinghsandhu/angadsinghsandhu/actions/artifacts/";
const sha = z.string().regex(/^[a-f0-9]{40}(?![\s\S])/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/u);
const id = z.number().int().positive();
const environmentId = z
  .string()
  .regex(/^[1-9][0-9]*(?![\s\S])/u)
  .transform(Number)
  .pipe(id);
const uploaded = z.object({
  portfolioSha: sha,
  notesSha: sha,
  runId: environmentId,
  runAttempt: environmentId,
  artifactId: environmentId,
  archiveSha256: sha256,
});
const githubArtifact = z.object({
  id,
  name: z.string(),
  expired: z.literal(false),
  expires_at: z.iso.datetime(),
  digest: z.string(),
  workflow_run: z.object({
    id,
    repository_id: z.literal(portfolioRepositoryId),
    head_repository_id: z.literal(portfolioRepositoryId),
    head_branch: z.literal("main"),
    head_sha: sha,
  }),
});

export async function readReleaseArtifactProof(
  upload: unknown,
  snapshotDirectory: string,
  api: Parameters<typeof readGitHub>[1],
): Promise<ReleaseReceipt> {
  const receipt = uploaded.parse(upload);
  const snapshot = await readProductionNotesSnapshot(snapshotDirectory);
  if (snapshot.receipt.sourceSha !== receipt.notesSha)
    throw new Error(
      "Validated Notes snapshot revision differs from the selected revision",
    );

  const artifact = await readGitHub(
    artifactPath + receipt.artifactId,
    api,
    githubArtifact,
  );
  if (
    !artifact ||
    artifact.id !== receipt.artifactId ||
    artifact.name !==
      `portfolio-candidate-${receipt.runId}-${receipt.runAttempt}` ||
    artifact.digest !== `sha256:${receipt.archiveSha256}` ||
    artifact.workflow_run.id !== receipt.runId ||
    artifact.workflow_run.head_sha !== receipt.portfolioSha ||
    !(Date.parse(artifact.expires_at) > Date.now())
  ) {
    throw new Error("GitHub artifact proof does not match the verified upload");
  }

  return {
    ...receipt,
    snapshotSchema: snapshot.manifest.schemaVersion,
    manifestSha256: snapshot.receipt.manifestSha256,
  };
}

if (import.meta.main) {
  try {
    const env = process.env;
    if (!env.GITHUB_OUTPUT)
      throw new Error("Run artifact proof inside GitHub Actions");
    const receipt = await readReleaseArtifactProof(
      {
        portfolioSha: env.PORTFOLIO_SHA,
        notesSha: env.NOTES_REVISION,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
        artifactId: env.CANDIDATE_ARTIFACT_ID,
        archiveSha256: env.CANDIDATE_ARTIFACT_DIGEST,
      },
      notesSnapshotDirectory,
      { token: env.PORTFOLIO_ARTIFACT_TOKEN ?? "" },
    );
    await appendFile(
      env.GITHUB_OUTPUT,
      `release_receipt=${JSON.stringify(receipt)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
