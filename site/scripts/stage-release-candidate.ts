import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { outputOrigin } from "./notes-redirects.ts";
import { downloadReleaseArtifactArchive } from "./release-artifact-transport.ts";
import { verifyReleaseMarker } from "./release-build-marker.ts";
import {
  practiceBundleProofSchema,
  type ReleaseReceipt,
} from "./release-policy.ts";
import { verifyPracticeBundle } from "./verify-practice-bundle.ts";

const stageArchive = promisify(execFile);
const script = fileURLToPath(
  new URL("./stage-release-archive.py", import.meta.url),
);

type StageConfig = {
  api: Parameters<typeof downloadReleaseArtifactArchive>[1];
  scratchParent: string;
  executable: string;
  pythonExecutable: string;
  origin: string;
};

export function createReleaseStage({
  api,
  scratchParent,
  executable,
  pythonExecutable,
  origin: approvedOrigin,
}: StageConfig) {
  const origin = outputOrigin(approvedOrigin);

  return async function withStage<T>(
    receipt: ReleaseReceipt,
    run: (stage: {
      directory: string;
      executable: string;
      workerDirectory?: string;
    }) => Promise<T>,
  ): Promise<T> {
    if (
      !isAbsolute(scratchParent) ||
      (await realpath(scratchParent)) !== scratchParent ||
      !(await stat(scratchParent)).isDirectory()
    )
      throw new Error("Release scratch must be a canonical absolute directory");

    for (const path of [pythonExecutable, executable]) {
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        !(await stat(path)).isFile()
      )
        throw new Error("Release staging requires pinned executable paths");
      await access(path, constants.X_OK);
    }

    const practice = practiceBundleProofSchema
      .optional()
      .parse(receipt.practice);
    const scratch = await mkdtemp(join(scratchParent, ".portfolio-release-"));
    try {
      const archive = join(scratch, "candidate.zip");
      const assets = join(scratch, "assets");
      await downloadReleaseArtifactArchive(receipt, api, archive);
      await stageArchive(pythonExecutable, ["-I", script, archive, assets], {
        cwd: scratch,
        env: {},
        shell: false,
        timeout: 300_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      }).catch(() => {
        throw new Error("Could not stage the verified release archive");
      });
      const directory = practice ? join(assets, "pages") : assets;
      const workerDirectory = practice
        ? join(assets, "worker-assets")
        : undefined;
      if (practice && workerDirectory) {
        await verifyPracticeBundle(assets, practice);
        await Promise.all([
          chmod(directory, 0o700),
          chmod(workerDirectory, 0o700),
        ]);
      }
      await verifyReleaseMarker(directory, {
        origin,
        portfolioSha: receipt.portfolioSha,
        notesSha: receipt.notesSha,
        runId: receipt.runId,
        runAttempt: receipt.runAttempt,
      });
      return await run({
        directory,
        executable,
        ...(workerDirectory ? { workerDirectory } : {}),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
