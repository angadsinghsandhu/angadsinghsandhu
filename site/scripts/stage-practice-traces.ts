import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NotesSnapshot } from "../src/lib/notes-snapshot.ts";
import { physicalLines } from "./output-text.ts";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export const artifactMaxFiles = 20_000;
const artifactMaxFileBytes = 25 * 1024 * 1024;

type TraceFile = [path: string, bytes: number, sha256: string];

export function digestTraceTree(files: TraceFile[]) {
  const digest = createHash("sha256");
  for (const file of files.toSorted(([left], [right]) =>
    left.localeCompare(right, "en"),
  ))
    digest.update(JSON.stringify(file) + "\n");
  return digest.digest("hex");
}

export async function readTraceAsset(
  file: string,
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error(`Unsafe trace asset: ${path}`);
  if (
    stat.size <= 0 ||
    stat.size > artifactMaxFileBytes ||
    (expectedBytes !== undefined && stat.size !== expectedBytes)
  )
    throw new Error(`Invalid trace asset size: ${path}`);
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || sha256(bytes) !== expectedSha256)
    throw new Error(`Trace asset digest differs: ${path}`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (physicalLines(text) > 500)
    throw new Error(`Trace asset exceeds 500 physical lines: ${path}`);
  return bytes;
}

export async function pagesTreeDigest(root: string) {
  const digest = createHash("sha256");
  let files = 0;
  async function walk(path: string) {
    const target = join(root, path);
    const stat = await lstat(target);
    if (stat.isDirectory()) {
      for (const name of (await readdir(target)).sort())
        await walk(path ? `${path}/${name}` : name);
      return;
    }
    if (!stat.isFile() || !path)
      throw new Error(`Unsafe Pages artifact: ${path}`);
    if (++files > artifactMaxFiles || stat.size > artifactMaxFileBytes)
      throw new Error(`Pages artifact exceeds a file limit: ${path}`);
    const file = createHash("sha256");
    for await (const bytes of createReadStream(target)) file.update(bytes);
    digest.update(JSON.stringify([path, stat.size, file.digest("hex")]) + "\n");
  }
  await walk("");
  return digest.digest("hex");
}

export async function writePracticeTraceAssets(
  workerAssets: NotesSnapshot["workerAssets"],
  worker: string,
) {
  if (workerAssets.length > artifactMaxFiles)
    throw new Error("Practice trace Worker exceeds the file limit");

  await mkdir(worker);
  await mkdir(join(worker, "practice-traces"));
  const files: TraceFile[] = [];
  const ordered = [...workerAssets].sort((a, b) =>
    a.publicPath.localeCompare(b.publicPath, "en"),
  );
  for (const asset of ordered) {
    const path = `practice-traces/${asset.sha256}.json`;
    if (
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      asset.publicPath !== "/" + path
    )
      throw new Error(`Invalid trace Worker asset: ${asset.publicPath}`);
    const bytes = await readTraceAsset(
      asset.file,
      path,
      asset.sha256,
      asset.bytes,
    );
    await writeFile(join(worker, path), bytes, { flag: "wx" });
    files.push([path, asset.bytes, asset.sha256]);
  }
  return {
    workerSha256: digestTraceTree(files),
    workerFiles: workerAssets.length,
  };
}

export async function stagePracticeTraces(
  { receipt, workerAssets }: Pick<NotesSnapshot, "receipt" | "workerAssets">,
  pages: string,
  worker: string,
) {
  if (receipt.mode !== "preview")
    throw new Error("Practice trace staging requires an isolated preview");

  const proof = await writePracticeTraceAssets(workerAssets, worker);
  return {
    ...receipt,
    pagesSha256: await pagesTreeDigest(pages),
    ...proof,
  };
}
