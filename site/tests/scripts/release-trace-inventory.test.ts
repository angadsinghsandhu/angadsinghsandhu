import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  emptyTraceCatalog,
  probeTraceBundle,
  stageTraceInventory,
  traceCatalogPath,
  verifyPublishedTraceInventory,
} from "../../scripts/release-trace-inventory.ts";
import { digestTraceTree } from "../../scripts/stage-practice-traces.ts";

async function fixture(check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "portfolio-trace-inventory-"));
  try {
    await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function candidate(root: string, name: string) {
  const bytes = Buffer.from(JSON.stringify({ name }));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = `/practice-traces/${sha}.json`;
  const directory = join(root, name);
  await mkdir(join(directory, "practice-traces"), { recursive: true });
  await writeFile(join(directory, path.slice(1)), bytes);
  return {
    bytes,
    path,
    directory,
    proof: {
      workerFiles: 1,
      workerSha256: digestTraceTree([[path.slice(1), bytes.length, sha]]),
    },
  };
}

const empty = async (path: string) => {
  expect(path).toBe(traceCatalogPath);
  return Buffer.from(emptyTraceCatalog);
};
const fromDisk = (root: string) => (path: string) =>
  readFile(join(root, path.slice(1)));

test("retains exact historical files and manifests through another deploy and retry", () =>
  fixture(async (root) => {
    const first = await candidate(root, "first");
    const firstLive = join(root, "live-first");
    const firstCatalog = await stageTraceInventory(
      first.directory,
      first.proof,
      firstLive,
      empty,
    );
    const second = await candidate(root, "second");
    const secondLive = join(root, "live-second");
    const secondCatalog = await stageTraceInventory(
      second.directory,
      second.proof,
      secondLive,
      fromDisk(firstLive),
    );
    const live = fromDisk(secondLive);
    await verifyPublishedTraceInventory(secondCatalog, live);
    await probeTraceBundle(first.proof, live);
    await probeTraceBundle(second.proof, live);
    expect(await live(first.path)).toEqual(first.bytes);
    expect(await live(second.path)).toEqual(second.bytes);
    await expect(
      verifyPublishedTraceInventory(firstCatalog, live),
    ).rejects.toThrow(/catalog/i);
    expect(
      await stageTraceInventory(
        second.directory,
        second.proof,
        join(root, "retry"),
        live,
      ),
    ).toEqual(secondCatalog);
  }));

test("rejects a missing, malformed, or oversized origin catalog", () =>
  fixture(async (root) => {
    const next = await candidate(root, "next");
    const output = join(root, "out");
    await expect(
      stageTraceInventory(next.directory, next.proof, output, async () => {
        throw new Error("404");
      }),
    ).rejects.toThrow("404");
    await expect(
      stageTraceInventory(next.directory, next.proof, output, async () =>
        Buffer.from(
          '{"version":1,"packages":[["../unsafe",1]],"manifests":[]}',
        ),
      ),
    ).rejects.toThrow();
    await expect(
      stageTraceInventory(
        next.directory,
        next.proof,
        output,
        async (_path, limit) => Buffer.alloc(limit + 1),
      ),
    ).rejects.toThrow(/limit/i);
  }));

test("rejects corrupted prior bytes and an altered candidate proof", () =>
  fixture(async (root) => {
    const first = await candidate(root, "first");
    const firstLive = join(root, "live-first");
    await stageTraceInventory(first.directory, first.proof, firstLive, empty);
    const next = await candidate(root, "next");
    await expect(
      stageTraceInventory(
        next.directory,
        first.proof,
        join(root, "forged"),
        fromDisk(firstLive),
      ),
    ).rejects.toThrow(/proof/i);
    await writeFile(
      join(firstLive, first.path.slice(1)),
      Buffer.alloc(first.bytes.length),
    );
    await expect(
      probeTraceBundle(first.proof, fromDisk(firstLive)),
    ).rejects.toThrow(/digest/i);
    await expect(
      stageTraceInventory(
        next.directory,
        next.proof,
        join(root, "out"),
        fromDisk(firstLive),
      ),
    ).rejects.toThrow(/digest/i);
  }));

test("requires the retained manifest and its packages to be in the current catalog", () =>
  fixture(async (root) => {
    const first = await candidate(root, "first");
    const live = join(root, "live");
    await stageTraceInventory(first.directory, first.proof, live, empty);
    await writeFile(join(live, traceCatalogPath.slice(1)), emptyTraceCatalog);
    await expect(probeTraceBundle(first.proof, fromDisk(live))).rejects.toThrow(
      /catalog/i,
    );
  }));
