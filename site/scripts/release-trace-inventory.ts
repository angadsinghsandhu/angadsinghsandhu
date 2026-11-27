import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { physicalLines } from "./output-text.ts";
import {
  artifactMaxFiles,
  digestTraceTree,
  readTraceAsset,
} from "./stage-practice-traces.ts";
import type { PracticeBundleProof } from "./verify-practice-bundle.ts";

const traceDirectory = "practice-traces";
export const traceCatalogPath = `/${traceDirectory}/_catalog.json`;
const maxMetadataBytes = 4 * 1024 * 1024;
const maxFileBytes = 25 * 1024 * 1024;
const maxInventoryBytes = 512 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/u);
const packageRecord = z.tuple([
  hash,
  z.number().int().min(1).max(maxFileBytes),
]);
const packagesSchema = z.array(packageRecord).max(artifactMaxFiles);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  packages: packagesSchema.min(1),
});
const catalogSchema = z.strictObject({
  version: z.literal(1),
  packages: packagesSchema,
  manifests: z.array(hash).max(artifactMaxFiles),
});
type Entry = z.infer<typeof packageRecord>;
type Catalog = z.infer<typeof catalogSchema>;
type WorkerProof = Pick<PracticeBundleProof, "workerSha256" | "workerFiles">;
export type ReadTraceInventoryFile = (
  path: string,
  maximumBytes: number,
) => Promise<Buffer>;

const packagePath = (sha: string) => `/${traceDirectory}/${sha}.json`;
const manifestPath = (sha: string) =>
  `/${traceDirectory}/manifests/${sha}.json`;
const serialize = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
export const emptyTraceCatalog = serialize({
  version: 1,
  packages: [],
  manifests: [],
}).toString("utf8");

function decodeText(bytes: Buffer, path: string) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (physicalLines(text) > 500)
    throw new Error(`Trace inventory file exceeds 500 physical lines: ${path}`);
  return text;
}

async function readMetadata<S extends z.ZodType>(
  path: string,
  read: ReadTraceInventoryFile,
  schema: S,
) {
  const bytes = await read(path, maxMetadataBytes);
  if (bytes.length > maxMetadataBytes)
    throw new Error(`Trace metadata exceeds its size limit: ${path}`);
  return { bytes, data: schema.parse(JSON.parse(decodeText(bytes, path))) };
}

function packageMap(packages: Entry[]) {
  const map = new Map(packages);
  if (map.size !== packages.length) throw new Error("Duplicate trace package");
  return map;
}

function validateCatalog(catalog: Catalog) {
  if (new Set(catalog.manifests).size !== catalog.manifests.length)
    throw new Error("Duplicate trace manifest");
  if (catalog.packages.length + catalog.manifests.length + 1 > artifactMaxFiles)
    throw new Error("Published trace inventory exceeds the file limit");
  if (
    catalog.packages.reduce((sum, [, bytes]) => sum + bytes, 0) >
    maxInventoryBytes
  )
    throw new Error(
      "Published trace inventory exceeds the aggregate size limit",
    );
  return packageMap(catalog.packages);
}

function digest(packages: Entry[]) {
  return digestTraceTree(
    packages.map(([sha, bytes]) => [packagePath(sha).slice(1), bytes, sha]),
  );
}

async function readManifest(sha: string, read: ReadTraceInventoryFile) {
  const result = await readMetadata(manifestPath(sha), read, manifestSchema);
  const { packages } = result.data;
  packageMap(packages);
  if (digest(packages) !== sha)
    throw new Error("Retained trace manifest digest differs from its identity");
  return result;
}

async function readPublishedPackage(
  [sha, size]: Entry,
  read: ReadTraceInventoryFile,
) {
  const path = packagePath(sha);
  const bytes = await read(path, size);
  if (
    bytes.length !== size ||
    createHash("sha256").update(bytes).digest("hex") !== sha
  )
    throw new Error(`Published trace package digest or size differs: ${path}`);
  decodeText(bytes, path);
  return bytes;
}

async function readLocalManifest(directory: string, proof: WorkerProof) {
  hash.parse(proof.workerSha256);
  const traceRoot = join(directory, traceDirectory);
  if (
    !(await lstat(directory)).isDirectory() ||
    !(await lstat(traceRoot)).isDirectory()
  )
    throw new Error("Unsafe local trace inventory directory");
  const rootNames = await readdir(directory);
  const names = (await readdir(traceRoot)).sort();
  if (
    rootNames.length !== 1 ||
    rootNames[0] !== traceDirectory ||
    names.length < 1 ||
    names.length > artifactMaxFiles ||
    names.length !== proof.workerFiles
  )
    throw new Error("Local trace files differ from the checked proof");
  const packages: Entry[] = [];
  let total = 0;
  for (const name of names) {
    const sha = hash.parse(name.slice(0, -5));
    if (name !== `${sha}.json`) throw new Error("Invalid trace package name");
    const bytes = await readTraceAsset(
      join(traceRoot, name),
      packagePath(sha),
      sha,
    );
    total += bytes.length;
    if (total > maxInventoryBytes)
      throw new Error("Local trace inventory exceeds the aggregate size limit");
    packages.push([sha, bytes.length]);
  }
  if (digest(packages) !== proof.workerSha256)
    throw new Error("Local trace inventory differs from the checked proof");
  return packages;
}

async function walkPublished(
  catalog: Catalog,
  read: ReadTraceInventoryFile,
  metadataBytes: number,
  preserve: (path: string, bytes: Buffer) => Promise<void>,
) {
  const files = validateCatalog(catalog);
  let total =
    metadataBytes + catalog.packages.reduce((sum, [, size]) => sum + size, 0);
  if (total > maxInventoryBytes)
    throw new Error(
      "Published trace inventory exceeds the aggregate size limit",
    );
  const referenced = new Set<string>();
  for (const sha of catalog.manifests) {
    const manifest = await readManifest(sha, read);
    total += manifest.bytes.length;
    if (total > maxInventoryBytes)
      throw new Error(
        "Published trace inventory exceeds the aggregate size limit",
      );
    for (const [key, size] of manifest.data.packages) {
      if (files.get(key) !== size)
        throw new Error(
          "Retained trace manifest is missing an exact catalog package",
        );
      referenced.add(key);
    }
    await preserve(manifestPath(sha), manifest.bytes);
  }
  if (referenced.size !== files.size)
    throw new Error("Published trace inventory has an unreferenced package");
  for (const entry of catalog.packages)
    await preserve(
      packagePath(entry[0]),
      await readPublishedPackage(entry, read),
    );
}

export async function stageTraceInventory(
  candidateWorkerDir: string,
  proof: WorkerProof,
  newWorkerDir: string,
  read: ReadTraceInventoryFile,
) {
  const previous = await readMetadata(traceCatalogPath, read, catalogSchema);
  const local = await readLocalManifest(candidateWorkerDir, proof);
  const packages = validateCatalog(previous.data);
  for (const [sha, size] of local) {
    const prior = packages.get(sha);
    if (prior !== undefined && prior !== size)
      throw new Error("Candidate and published trace package sizes disagree");
    packages.set(sha, size);
  }
  const newManifest = !previous.data.manifests.includes(proof.workerSha256);
  const catalog: Catalog = {
    version: 1,
    packages: [...packages.entries()].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    ),
    manifests: [
      ...new Set([...previous.data.manifests, proof.workerSha256]),
    ].sort(),
  };
  validateCatalog(catalog);
  const metadata = serialize(catalog);
  const manifest = serialize({ version: 1, packages: local });
  if (metadata.length > maxMetadataBytes || manifest.length > maxMetadataBytes)
    throw new Error("Trace metadata exceeds its size limit");

  await mkdir(newWorkerDir, { mode: 0o700 });
  await mkdir(join(newWorkerDir, traceDirectory, "manifests"), {
    recursive: true,
  });
  const preserve = (path: string, bytes: Buffer) =>
    writeFile(join(newWorkerDir, path.slice(1)), bytes, { flag: "wx" });
  const old = packageMap(previous.data.packages);
  const added = local.filter(([sha]) => !old.has(sha));
  const addedBytes = added.reduce((sum, [, size]) => sum + size, 0);
  await walkPublished(
    previous.data,
    read,
    metadata.length + (newManifest ? manifest.length : 0) + addedBytes,
    preserve,
  );
  for (const [sha, size] of added)
    await preserve(
      packagePath(sha),
      await readTraceAsset(
        join(candidateWorkerDir, packagePath(sha).slice(1)),
        packagePath(sha),
        sha,
        size,
      ),
    );
  if (newManifest) await preserve(manifestPath(proof.workerSha256), manifest);
  await preserve(traceCatalogPath, metadata);
  return metadata;
}

export async function probeTraceBundle(
  proof: WorkerProof,
  read: ReadTraceInventoryFile,
) {
  const sha = hash.parse(proof.workerSha256);
  const { data: catalog } = await readMetadata(
    traceCatalogPath,
    read,
    catalogSchema,
  );
  const available = validateCatalog(catalog);
  if (!catalog.manifests.includes(sha))
    throw new Error(
      "Expected trace manifest is absent from the published catalog",
    );
  const { data } = await readManifest(sha, read);
  if (data.packages.length !== proof.workerFiles)
    throw new Error(
      "Published trace package count differs from the checked proof",
    );
  for (const entry of data.packages) {
    if (available.get(entry[0]) !== entry[1])
      throw new Error(
        "Expected trace package differs from the published catalog",
      );
    await readPublishedPackage(entry, read);
  }
}

export async function verifyPublishedTraceInventory(
  expectedCatalog: Buffer,
  read: ReadTraceInventoryFile,
) {
  const catalog = await readMetadata(traceCatalogPath, read, catalogSchema);
  if (!catalog.bytes.equals(expectedCatalog))
    throw new Error("Published trace catalog differs from the staged catalog");
  await walkPublished(catalog.data, read, catalog.bytes.length, async () => {});
}
