import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NotesSnapshot } from "../src/lib/notes-snapshot.ts";
import { physicalLines } from "./output-text.ts";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function pagesTreeDigest(root: string) {
  const digest = createHash("sha256");
  async function walk(path: string) {
    const target = join(root, path);
    const stat = await lstat(target);
    if (stat.isDirectory()) {
      for (const name of (await readdir(target)).sort())
        await walk(path ? `${path}/${name}` : name);
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsafe Pages artifact: ${path}`);
    const file = createHash("sha256");
    for await (const bytes of createReadStream(target)) file.update(bytes);
    digest.update(JSON.stringify([path, stat.size, file.digest("hex")]) + "\n");
  }
  await walk("");
  return digest.digest("hex");
}

export async function stagePracticeTraces(
  { receipt, workerAssets }: Pick<NotesSnapshot, "receipt" | "workerAssets">,
  pages: string,
  worker: string,
) {
  if (receipt.mode !== "preview")
    throw new Error("Practice trace staging requires an isolated preview");
  if (workerAssets.length > 20_000)
    throw new Error("Practice trace Worker exceeds the file limit");

  await mkdir(worker);
  await mkdir(join(worker, "practice-traces"));
  const digest = createHash("sha256");
  const ordered = [...workerAssets].sort((a, b) =>
    a.publicPath.localeCompare(b.publicPath, "en"),
  );
  for (const asset of ordered) {
    const path = `practice-traces/${asset.sha256}.json`;
    if (
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      asset.publicPath !== "/" + path ||
      asset.bytes <= 0 ||
      asset.bytes > 25 * 1024 * 1024
    )
      throw new Error(`Invalid trace Worker asset: ${asset.publicPath}`);
    const stat = await lstat(asset.file);
    if (!stat.isFile() || stat.size !== asset.bytes)
      throw new Error(`Unsafe or incorrectly sized trace asset: ${path}`);
    const bytes = await readFile(asset.file);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
      throw new Error(`Trace asset digest differs: ${path}`);
    if (
      physicalLines(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) >
      500
    )
      throw new Error(`Trace asset exceeds 500 physical lines: ${path}`);
    await writeFile(join(worker, path), bytes, { flag: "wx" });
    digest.update(JSON.stringify([path, asset.bytes, asset.sha256]) + "\n");
  }
  return {
    ...receipt,
    pagesSha256: await pagesTreeDigest(pages),
    workerSha256: digest.digest("hex"),
    workerFiles: workerAssets.length,
  };
}
