import { appendFile } from "node:fs/promises";
import { z } from "zod";
import {
  notesSnapshotDirectory,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";
import {
  checkReleaseArtifactMetadata,
  releaseArtifactIdentity,
} from "./release-artifact-download.ts";
import type { ReleaseReceipt } from "./release-policy.ts";

const sha = z.string().regex(/^[a-f0-9]{40}(?![\s\S])/u);
const environmentId = z
  .string()
  .regex(/^[1-9][0-9]*(?![\s\S])/u)
  .transform(Number)
  .pipe(releaseArtifactIdentity.shape.artifactId);
const uploaded = releaseArtifactIdentity.extend({
  notesSha: sha,
  runId: environmentId,
  runAttempt: environmentId,
  artifactId: environmentId,
});

export async function readReleaseArtifactProof(
  upload: unknown,
  snapshotDirectory: string,
  api: Parameters<typeof checkReleaseArtifactMetadata>[1],
): Promise<ReleaseReceipt> {
  const receipt = uploaded.parse(upload);
  const snapshot = await readProductionNotesSnapshot(snapshotDirectory);
  if (snapshot.receipt.sourceSha !== receipt.notesSha)
    throw new Error(
      "Validated Notes snapshot revision differs from the selected revision",
    );

  await checkReleaseArtifactMetadata(receipt, api);

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
