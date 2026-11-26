import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const lockJson = (value) => JSON.stringify(value, null, 2) + "\n";

export function readLock(directory) {
  const header = readJson(join(directory, "index.json"));
  const packages = Object.create(null);
  const shards = readdirSync(directory)
    .filter((file) => /^packages-\d+\.json$/u.test(file))
    .sort();

  for (const shard of shards) {
    for (const [name, entry] of Object.entries(
      readJson(join(directory, shard)),
    )) {
      if (Object.hasOwn(packages, name))
        throw new Error(`Duplicate lock entry: ${name}`);
      packages[name] = entry;
    }
  }

  if (!Object.hasOwn(packages, ""))
    throw new Error("Missing lock root package");
  return { ...header, packages: { ...packages } };
}

export function writeLockParts({ packages, ...header }, directory) {
  mkdirSync(directory);
  writeFileSync(join(directory, "index.json"), lockJson(header));

  const shardLimit = 480;
  let shard = {};
  let lines = 2;
  let shardNumber = 1;
  const flush = () => {
    const file = `packages-${String(shardNumber).padStart(3, "0")}.json`;
    writeFileSync(join(directory, file), lockJson(shard));
    shardNumber++;
    shard = {};
    lines = 2;
  };

  for (const name of Object.keys(packages).sort()) {
    const entry = packages[name];
    const entryLines = lockJson({ [name]: entry }).split("\n").length - 3;
    if (entryLines + 2 > shardLimit)
      throw new Error(`Lock entry exceeds shard size: ${name}`);
    if (lines + entryLines > shardLimit) flush();
    shard[name] = entry;
    lines += entryLines;
  }
  flush();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      "Usage: node scripts/lock.mjs package-lock.json new-lock-directory",
    );
  writeLockParts(readJson(input), output);
}
