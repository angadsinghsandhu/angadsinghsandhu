import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const distribution = dirname(require.resolve("pdfjs-dist/package.json"));
/** Exact files from the pinned distribution; PDF scripting (QuickJS) is never staged. */
async function pdfAssets(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  files.set("LICENSE", await readFile(join(distribution, "LICENSE")));
  files.set(
    "pdf.worker.min.mjs",
    await readFile(join(distribution, "build/pdf.worker.min.mjs")),
  );
  for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    for (const name of (await readdir(join(distribution, directory))).sort()) {
      if (name.startsWith("quickjs")) continue;
      const path = join(directory, name);
      files.set(path, await readFile(join(distribution, path)));
    }
  }
  return files;
}
export async function stagePdfAssets(target: string): Promise<void> {
  const assets = await pdfAssets();
  const directories = new Set([
    target,
    ...[...assets.keys()].map((path) => dirname(join(target, path))),
  ]);
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe PDF asset directory: ${directory}`);
  }
  await Promise.all(
    [...assets].map(async ([path]) => {
      const file = join(target, path);
      const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error(`Unsafe PDF asset: ${file}`);
    }),
  );
  await Promise.all(
    [...assets].map(([path, bytes]) => writeFile(join(target, path), bytes)),
  );
}
