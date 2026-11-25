import { createHash } from "node:crypto";
import { z } from "zod";
import { readGitHub } from "./release-source-proof.ts";

const portfolioRepositoryId = 339077137;
export const releaseArtifactPath =
  "/repos/angadsinghsandhu/angadsinghsandhu/actions/artifacts/";
const sha = z.string().regex(/^[a-f0-9]{40}(?![\s\S])/u);
const id = z.number().int().positive();
export const releaseArtifactIdentity = z.object({
  portfolioSha: sha,
  runId: id,
  runAttempt: id,
  artifactId: id,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/u),
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

type ArtifactIdentity = z.infer<typeof releaseArtifactIdentity>;
type GitHubReader = Parameters<typeof readGitHub>[1];

export async function checkReleaseArtifactMetadata(
  receipt: ArtifactIdentity,
  api: GitHubReader,
): Promise<ArtifactIdentity> {
  const expected = releaseArtifactIdentity.parse(receipt);
  const artifact = await readGitHub(
    releaseArtifactPath + expected.artifactId,
    api,
    githubArtifact,
  );
  if (
    !artifact ||
    artifact.id !== expected.artifactId ||
    artifact.name !==
      `portfolio-candidate-${expected.runId}-${expected.runAttempt}` ||
    artifact.digest !== `sha256:${expected.archiveSha256}` ||
    artifact.workflow_run.id !== expected.runId ||
    artifact.workflow_run.head_sha !== expected.portfolioSha ||
    !(Date.parse(artifact.expires_at) > Date.now())
  ) {
    throw new Error("GitHub artifact proof does not match the verified upload");
  }
  return expected;
}

export async function readReleaseArtifactArchive(
  receipt: ArtifactIdentity,
  {
    api,
    readArchive,
  }: {
    api: GitHubReader;
    readArchive: (artifactId: number) => Promise<Uint8Array>;
  },
): Promise<Uint8Array> {
  const expected = await checkReleaseArtifactMetadata(receipt, api);
  // shortcut: owns the archive in memory, stage verified bytes on disk if runner limits require it.
  const archive = Buffer.from(await readArchive(expected.artifactId));
  if (
    createHash("sha256").update(archive).digest("hex") !==
    expected.archiveSha256
  )
    throw new Error(
      "Downloaded archive digest does not match the release receipt",
    );
  return archive;
}
