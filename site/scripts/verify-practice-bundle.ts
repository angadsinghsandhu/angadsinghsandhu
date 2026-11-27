import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { NotesSnapshot } from "../src/lib/notes-snapshot.ts";
import {
  artifactMaxFiles,
  digestTraceTree,
  pagesTreeDigest,
  readTraceAsset,
} from "./stage-practice-traces.ts";

export type PracticeBundleProof = {
  pagesSha256: string;
  workerSha256: string;
  workerFiles: number;
};

async function requireDirectories(parent: string, expected: string[]) {
  if (!(await lstat(parent)).isDirectory())
    throw new Error(`Unsafe practice bundle directory: ${parent}`);
  const entries = await readdir(parent, { withFileTypes: true });
  if (
    entries.length !== expected.length ||
    entries.some(
      (entry) => !entry.isDirectory() || !expected.includes(entry.name),
    )
  )
    throw new Error(`Invalid practice bundle layout: ${parent}`);
}

export async function readPracticeBundleProof(
  root: string,
): Promise<PracticeBundleProof> {
  await requireDirectories(root, ["pages", "worker-assets"]);
  const worker = join(root, "worker-assets");
  await requireDirectories(worker, ["practice-traces"]);
  const traceDirectory = join(worker, "practice-traces");
  const names = await readdir(traceDirectory);
  if (names.length > artifactMaxFiles)
    throw new Error("Practice trace Worker exceeds the file limit");

  const files: Parameters<typeof digestTraceTree>[0] = [];
  for (const name of names.sort()) {
    const match = /^([a-f0-9]{64})\.json(?![\s\S])/u.exec(name);
    if (!match) throw new Error(`Invalid practice trace asset path: ${name}`);
    const path = `practice-traces/${name}`;
    const sha256 = match[1]!;
    const bytes = await readTraceAsset(
      join(traceDirectory, name),
      path,
      sha256,
    );
    files.push([path, bytes.length, sha256]);
  }

  return {
    pagesSha256: await pagesTreeDigest(join(root, "pages")),
    workerSha256: digestTraceTree(files),
    workerFiles: files.length,
  };
}

export async function verifyPracticeBundle(
  root: string,
  expected: PracticeBundleProof,
) {
  const actual = await readPracticeBundleProof(root);
  if (
    actual.pagesSha256 !== expected.pagesSha256 ||
    actual.workerSha256 !== expected.workerSha256 ||
    actual.workerFiles !== expected.workerFiles
  )
    throw new Error("Practice bundle does not match the release proof");
  return actual;
}

export async function readPracticeBundleForSnapshot(
  root: string,
  workerAssets: NotesSnapshot["workerAssets"],
) {
  if (!workerAssets.length)
    throw new Error(
      "Paired artifact requires trace assets in the Notes snapshot",
    );
  const proof = await readPracticeBundleProof(root);
  const expected = workerAssets.map(
    ({ publicPath, bytes, sha256 }) =>
      [publicPath.slice(1), bytes, sha256] as [string, number, string],
  );
  if (
    proof.workerFiles !== expected.length ||
    proof.workerSha256 !== digestTraceTree(expected)
  )
    throw new Error(
      "Trace Worker inventory differs from the checked Notes snapshot",
    );
  return proof;
}
