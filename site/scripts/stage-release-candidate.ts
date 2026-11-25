import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { outputOrigin } from "./notes-redirects.ts";
import { downloadReleaseArtifactArchive } from "./release-artifact-transport.ts";
import { verifyReleaseMarker } from "./release-build-marker.ts";
import type { ReleaseReceipt } from "./release-policy.ts";

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
    run: (stage: { directory: string; executable: string }) => Promise<T>,
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

    const scratch = await mkdtemp(join(scratchParent, ".portfolio-release-"));
    try {
      const archive = join(scratch, "candidate.zip");
      const directory = join(scratch, "assets");
      await downloadReleaseArtifactArchive(receipt, api, archive);
      await stageArchive(pythonExecutable, ["-I", script, archive, directory], {
        cwd: scratch,
        env: {},
        shell: false,
        timeout: 300_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      }).catch(() => {
        throw new Error("Could not stage the verified release archive");
      });
      await verifyReleaseMarker(directory, {
        origin,
        portfolioSha: receipt.portfolioSha,
        notesSha: receipt.notesSha,
        runId: receipt.runId,
        runAttempt: receipt.runAttempt,
      });
      return await run({ directory, executable });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
