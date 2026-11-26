import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { publicOutputKey } from "./notes-routes.ts";
import {
  portfolioSnapshotV1,
  type PortfolioSnapshotV1,
} from "./notes-snapshot-v1.ts";

export const notesSnapshotDirectory = ".generated/notes";
const inventoryDirectories = [
  "assets",
  "worker-assets",
  "worker-assets/practice-traces",
];
const fullRevision = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const receiptSchema = z.strictObject({
  mode: z.enum(["production", "preview"]),
  sourceSha: z.string().regex(fullRevision),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Receipt = z.infer<typeof receiptSchema>;
type Asset = PortfolioSnapshotV1["assets"][number];
type VerifiedAsset = Asset & { file: string };

export type NotesSnapshot = {
  receipt: Receipt;
  manifest: PortfolioSnapshotV1;
  pagesAssets: VerifiedAsset[];
  workerAssets: VerifiedAsset[];
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function requireDirectory(path: string) {
  if (!(await lstat(path)).isDirectory())
    throw new Error(`Unsafe snapshot directory: ${path}`);
}

async function readRegularFile(path: string, expectedSize?: number) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if (errorCode(error) === "ELOOP")
      throw new Error(`Unsafe snapshot file: ${path}`, { cause: error });
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Unsafe snapshot file: ${path}`);
    if (expectedSize !== undefined && stat.size !== expectedSize)
      throw new Error(`Snapshot file size differs: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size)
      throw new Error(`Snapshot file size changed during read: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON`, { cause: error });
  }
}

async function readReceipt(path: string): Promise<Receipt> {
  const result = receiptSchema.safeParse(
    parseJson(await readRegularFile(path), "Notes receipt"),
  );
  if (!result.success)
    throw new Error(`Invalid Notes receipt: ${result.error.message}`);
  return result.data;
}

async function readCurrentReceipt(dir: string) {
  try {
    await requireDirectory(dir);
    return await readReceipt(join(dir, "current.json"));
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw new Error("Import a verified Notes snapshot first", {
        cause: error,
      });
    throw error;
  }
}

function requireRevision(receipt: Receipt, expectedSha: string) {
  if (!fullRevision.test(expectedSha))
    throw new Error("An exact lowercase Notes revision is required");
  if (receipt.sourceSha !== expectedSha)
    throw new Error(
      "Notes receipt revision differs from the expected revision",
    );
}

async function requireExactTree(root: string, assets: readonly Asset[]) {
  const directories = new Set(inventoryDirectories);
  const files = new Set([
    "manifest.json",
    ...assets.map(({ exportPath }) => exportPath),
  ]);
  async function walk(relative: string) {
    const path = join(root, relative);
    await requireDirectory(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.delete(name)) await walk(name);
      else if (entry.isFile() && files.delete(name)) continue;
      else if (entry.isDirectory() || entry.isFile())
        throw new Error(`Unlisted snapshot path: ${name}`);
      else throw new Error(`Unsafe snapshot path: ${name}`);
    }
  }
  await walk("");
  if (directories.size || files.size)
    throw new Error(
      `Missing snapshot paths: ${[...directories, ...files].join(", ")}`,
    );
}

async function readVerifiedAsset(asset: VerifiedAsset) {
  const bytes = await readRegularFile(asset.file, asset.bytes);
  if (sha256(bytes) !== asset.sha256)
    throw new Error(`Snapshot asset digest differs: ${asset.file}`);
  return bytes;
}

async function readManifest(root: string, receipt: Receipt) {
  await requireDirectory(root);
  const manifestBytes = await readRegularFile(join(root, "manifest.json"));
  if (sha256(manifestBytes) !== receipt.manifestSha256)
    throw new Error("Notes manifest digest differs from the receipt");
  const result = portfolioSnapshotV1.safeParse(
    parseJson(manifestBytes, "Notes manifest"),
  );
  if (!result.success)
    throw new Error(`Invalid Notes manifest: ${result.error.message}`);
  const manifest = result.data;
  if (manifest.sourceSha !== receipt.sourceSha)
    throw new Error("Notes manifest revision differs from the receipt");
  if (manifest.mode !== receipt.mode)
    throw new Error("Notes manifest mode differs from the receipt");

  return { manifest, manifestBytes };
}

export async function readPinnedNotesManifest(dir: string, input: string) {
  const receipt = receiptSchema.parse(JSON.parse(input));
  await requireDirectory(dir);
  const { manifest } = await readManifest(
    join(dir, receipt.manifestSha256),
    receipt,
  );
  return manifest;
}

async function verifyArtifact(
  root: string,
  receipt: Receipt,
  copyTo?: string,
): Promise<NotesSnapshot> {
  const { manifest, manifestBytes } = await readManifest(root, receipt);
  const publicRoutes = [
    ...manifest.entries.flatMap(({ route, aliases }) => [route, ...aliases]),
    ...manifest.curriculum.lessons.map(({ route }) => route),
    ...manifest.assets.map(({ publicPath }) => publicPath),
    ...manifest.curriculum.traceAssets.map(({ publicPath }) => publicPath),
  ];
  const claims = new Set<string>();
  for (const route of publicRoutes) {
    const key = publicOutputKey(route);
    if (claims.has(key)) throw new Error(`Duplicate public route: ${route}`);
    claims.add(key);
  }

  const withFile = (asset: Asset): VerifiedAsset => ({
    ...asset,
    file: join(root, asset.exportPath),
  });
  const pagesAssets = manifest.assets.map(withFile);
  const workerAssets = manifest.curriculum.traceAssets.map(withFile);
  const assets = [...pagesAssets, ...workerAssets];
  await requireExactTree(root, assets);
  if (copyTo) {
    for (const directory of inventoryDirectories)
      await mkdir(join(copyTo, directory), { recursive: true });
    await writeFile(join(copyTo, "manifest.json"), manifestBytes, {
      flag: "wx",
    });
  }
  for (const asset of assets) {
    const bytes = await readVerifiedAsset(asset);
    if (copyTo)
      await writeFile(join(copyTo, asset.exportPath), bytes, { flag: "wx" });
  }
  return { receipt, manifest, pagesAssets, workerAssets };
}

export async function readNotesSnapshot(
  dir: string,
  expectedSha: string,
): Promise<NotesSnapshot> {
  const receipt = await readCurrentReceipt(dir);
  requireRevision(receipt, expectedSha);
  return verifyArtifact(join(dir, receipt.manifestSha256), receipt);
}

export async function readProductionNotesSnapshot(
  dir: string,
): Promise<NotesSnapshot> {
  const receipt = await readCurrentReceipt(dir);
  if (receipt.mode !== "production")
    throw new Error(
      "Notes preview snapshot cannot be used for a release build",
    );
  return verifyArtifact(join(dir, receipt.manifestSha256), receipt);
}

export async function importNotesSnapshot(
  source: string,
  dir: string,
  revision: string,
  receiptPath: string,
) {
  const receipt = await readReceipt(receiptPath);
  requireRevision(receipt, revision);
  await mkdir(dirname(dir), { recursive: true });
  await requireDirectory(dirname(dir));
  await mkdir(dir, { recursive: true });
  await requireDirectory(dir);
  const stage = await mkdtemp(join(dir, ".import-"));
  try {
    const candidate = join(stage, "snapshot");
    await verifyArtifact(source, receipt, candidate);
    const generation = join(dir, receipt.manifestSha256);
    try {
      await rename(candidate, generation);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? ""))
        throw error;
      await verifyArtifact(generation, receipt);
    }
    const next = join(stage, "current.json");
    await writeFile(next, JSON.stringify(receipt) + "\n", { flag: "wx" });
    await rename(next, join(dir, "current.json"));
    return receipt;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function copyNotesPagesAssets(
  snapshot: NotesSnapshot,
  output: string,
) {
  if (!snapshot.pagesAssets.length) return;
  await requireDirectory(output);
  const stage = await mkdtemp(join(output, ".notes-pages-"));
  try {
    for (const asset of snapshot.pagesAssets)
      await writeFile(
        join(stage, basename(asset.publicPath)),
        await readVerifiedAsset(asset),
        { flag: "wx" },
      );
    await rename(stage, join(output, "content-assets"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
