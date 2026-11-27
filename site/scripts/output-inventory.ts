import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  approved,
  indexes,
  profile,
  projects,
  releases,
  resumePdfPath,
} from "../src/content/editorial.ts";
import { notesLicenseFiles } from "../src/lib/notes-license-files.ts";
import { claimNotesRoutes } from "../src/lib/notes-routes.ts";
import type { NotesSnapshot } from "../src/lib/notes-snapshot.ts";
import { z } from "zod";
import { renderNotesRedirects, renderSitemap } from "./notes-redirects.ts";

const maximumFiles = 20_000;
const maximumBytes = 25 * 1024 * 1024;
const privatePath =
  /(?:^\/(?:worker-assets|practice-traces|drafts?|fixtures?|private|account|api|progress|functions|_worker\.js)|(?:^|\/)(?:\.[^/]+|manifest\.json|current\.json|[^/]*receipt\.json))(?:\/|$)/iu;

export function readOutput(directory: string, curriculum = false) {
  const files = new Map<string, number>();
  function walk(path: string) {
    const absolute = join(directory, path);
    const stat = lstatSync(absolute);
    if (
      privatePath.test(path) ||
      (!curriculum && /^\/practice(?:\/|$)/iu.test(path))
    )
      throw new Error(`Private output path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) walk(`${path}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsafe output path: ${path}`);
    if (stat.size > maximumBytes)
      throw new Error(`File exceeds 25 MiB: ${path} (${stat.size} bytes)`);
    files.set(path, stat.size);
    if (files.size > maximumFiles)
      throw new Error(`File count exceeds ${maximumFiles}`);
  }
  if (!lstatSync(directory).isDirectory())
    throw new Error(`Output must be a regular directory: ${directory}`);
  walk("");
  return files;
}

function publicFiles() {
  const directory = resolve("public");
  const paths = new Map<string, string>();
  const files = readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files) {
    if (!file.isFile()) continue;
    const absolute = join(file.parentPath, file.name);
    const path = absolute.slice(directory.length);
    if (path.toLowerCase() === "/_redirects")
      throw new Error(`Public file uses generated metadata path: ${path}`);
    if (path === resumePdfPath && !profile.resume)
      throw new Error("Unapproved résumé PDF in public");
    paths.set(path, absolute);
  }
  return paths;
}

export function pagePath(route: string) {
  return decodeURIComponent(route.replace(/\/?$/u, "/index.html"));
}

export function releaseInventory(snapshot: NotesSnapshot, origin: string) {
  const shell = [
    "/",
    "/projects/",
    "/music/",
    "/resume/",
    ...Object.keys(indexes)
      .filter((index) => index !== "library")
      .map((index) => `/${index}/`),
    ...approved(projects).map(({ slug }) => `/projects/${slug}/`),
    ...approved(releases).map(({ slug }) => `/music/${slug}/`),
  ];
  const publicAssets = publicFiles();
  const { pages, aliases } = claimNotesRoutes(
    snapshot,
    new Set([
      ...shell,
      ...publicAssets.keys(),
      "/404.html",
      "/sitemap.xml",
      "/_redirects",
    ]),
  );

  const canonical = new Map(
    [...shell, ...pages.keys()].map((route) => [
      pagePath(route),
      new URL(route, origin).href,
    ]),
  );
  const metadata = renderSitemap(origin, canonical.values());
  const redirects = renderNotesRedirects(aliases);
  if (redirects) metadata.set("_redirects", redirects);
  for (const path of metadata.keys())
    if (publicAssets.has("/" + path))
      throw new Error(
        `Generated metadata conflicts with public file: /${path}`,
      );
  for (const [alias, target] of aliases)
    canonical.set(pagePath(alias), new URL(target, origin).href);

  for (const asset of snapshot.pagesAssets)
    publicAssets.set(asset.publicPath, asset.file);
  if (
    snapshot.manifest.entries.length ||
    snapshot.manifest.curriculum.lessons.length
  )
    for (const { source, output } of notesLicenseFiles)
      publicAssets.set("/" + output, resolve("node_modules", source));

  return { aliases, canonical, metadata, publicAssets };
}

export function reportOutput(files: ReadonlyMap<string, number>) {
  const bytes = [...files.values()].reduce(
    (total, length) => total + length,
    0,
  );
  const largest = [...files]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5);
  console.log(JSON.stringify({ files: files.size, bytes, largest }, null, 2));
}

const searchInventoryPath = (receipt: NotesSnapshot["receipt"]) =>
  receipt.mode === "preview"
    ? `.generated/pages-search-preview-${receipt.manifestSha256}.json`
    : ".generated/pages-search-inventory.json";
const pagefindBundle =
  /^\/pagefind\/(?:pagefind(?:-entry\.json|-worker\.js|\.js|\.[\w-]+\.pf_meta)|wasm\.[\w-]+\.pagefind|(?:fragment\/[\w-]+\.pf_fragment|index\/[\w-]+\.pf_index|filter\/[\w-]+\.pf_filter))$/u;
const searchInventory = z.strictObject({
  mode: z.enum(["production", "preview"]),
  sourceSha: z.string(),
  manifestSha256: z.string(),
  origin: z.string(),
  files: z.record(
    z.string().regex(pagefindBundle),
    z.string().regex(/^[a-f0-9]{64}$/u),
  ),
});

const isPagefind = (path: string) => path.startsWith("/pagefind/");
const fileDigest = (directory: string, path: string) =>
  createHash("sha256")
    .update(readFileSync(join(directory, path)))
    .digest("hex");

export function writeSearchInventory(
  directory: string,
  receipt: NotesSnapshot["receipt"],
  origin: string,
  paired = false,
) {
  const files = Object.fromEntries(
    [...readOutput(directory, paired || receipt.mode === "preview").keys()]
      .filter(isPagefind)
      .map((path) => [path, fileDigest(directory, path)]),
  );
  const value = searchInventory.parse({ ...receipt, origin, files });
  const path = searchInventoryPath(receipt);
  const stage = mkdtempSync(join(dirname(path), ".search-inventory-"));
  try {
    const staged = join(stage, "receipt.json");
    writeFileSync(staged, JSON.stringify(value) + "\n", { flag: "wx" });
    renameSync(staged, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function verifySearchInventory(
  directory: string,
  files: ReadonlyMap<string, number>,
  receipt: NotesSnapshot["receipt"],
  origin: string,
) {
  const inventory = searchInventory.parse(
    JSON.parse(readFileSync(searchInventoryPath(receipt), "utf8")),
  );
  if (
    inventory.mode !== receipt.mode ||
    inventory.sourceSha !== receipt.sourceSha ||
    inventory.manifestSha256 !== receipt.manifestSha256 ||
    inventory.origin !== origin
  )
    throw new Error(
      "Pagefind inventory does not match the staged snapshot and origin",
    );
  for (const [path, digest] of Object.entries(inventory.files)) {
    if (!files.has(path)) throw new Error(`Missing Pagefind file: ${path}`);
    if (fileDigest(directory, path) !== digest)
      throw new Error(`Pagefind file digest differs: ${path}`);
  }
  for (const path of files.keys())
    if (isPagefind(path) && !Object.hasOwn(inventory.files, path))
      throw new Error(`Unlisted Pagefind file: ${path}`);
  return new Set(Object.keys(inventory.files));
}
