import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fromHtml } from "hast-util-from-html";
import { outputOrigin } from "./notes-redirects.ts";
import {
  pagePath,
  readOutput,
  releaseInventory,
  reportOutput,
  verifySearchInventory,
} from "./output-inventory.ts";
import { physicalLines } from "./output-text.ts";
import { pdfAssets } from "./pdf-assets.ts";
import {
  releaseMarkerFromEnvironment,
  releaseMarkerPath,
  verifyReleaseMarker,
} from "./release-build-marker.ts";
import {
  notesSnapshotDirectory,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";

const astroBundle =
  /^\/_astro\/[\w.-]+\.[\w-]{8}\.(?:css|js|woff2?|ttf|eot|gif|png|jpe?g|svg|webp|avif)$/u;

function routeFor(path: string) {
  return path.replace(/\/index\.html$/u, "/");
}

function documentInfo(html: string, route: string, origin: string) {
  const canonicals: string[] = [];
  const ids = new Set<string>();
  const links = new Set<string>();
  const pdfViewers = new Set<string>();
  const pdfDownloads = new Set<string>();
  const pdfOpenLinks = new Set<string>();
  const base = new URL(route, origin);
  const stack = [...fromHtml(html).children];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type !== "element") continue;
    stack.push(...node.children);
    const { id, name, href, rel, src, srcSet, poster, dataPdfUrl, data, as } =
      node.properties;
    if (typeof id === "string") ids.add(id);
    if (node.tagName === "a" && typeof name === "string") ids.add(name);
    if (node.tagName === "base")
      throw new Error(`Unexpected base URL on ${route}`);
    const relationships =
      node.tagName === "link" && Array.isArray(rel)
        ? rel.map((token) => String(token).toLowerCase())
        : [];
    if (relationships.includes("canonical")) {
      canonicals.push(String(href));
      continue;
    }
    const runtimeLink =
      relationships.includes("stylesheet") ||
      relationships.includes("modulepreload") ||
      (relationships.includes("preload") &&
        ["script", "style", "font", "worker"].includes(String(as)));
    for (const value of [
      node.tagName === "script" ? src : undefined,
      runtimeLink ? href : undefined,
      dataPdfUrl,
    ]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const url = URL.parse(value, base);
      if (url?.origin !== origin || url.protocol !== "https:")
        throw new Error(`Cross-origin runtime asset: ${route} → ${value}`);
      if (value === dataPdfUrl) pdfViewers.add(url.href);
    }
    if (node.tagName === "a" && typeof href === "string") {
      const url = URL.parse(href, base);
      if (
        url?.origin === origin &&
        url.pathname.startsWith("/content-assets/")
      ) {
        const action = Object.hasOwn(node.properties, "download")
          ? pdfDownloads
          : pdfOpenLinks;
        action.add(url.href);
      }
    }
    const candidates = [
      href,
      src,
      poster,
      dataPdfUrl,
      node.tagName === "object" ? data : undefined,
    ];
    if (typeof srcSet === "string" && !srcSet.startsWith("data:"))
      candidates.push(
        ...srcSet.split(",").map((item) => item.trim().split(/\s+/u)[0]),
      );
    for (const value of candidates) {
      if (typeof value !== "string" || !value.trim()) continue;
      const url = URL.parse(value, base);
      if (!url) throw new Error(`Invalid local reference: ${route} → ${value}`);
      if (url.origin === origin) links.add(url.pathname + url.hash);
    }
  }
  return { canonicals, ids, links, pdfViewers, pdfDownloads, pdfOpenLinks };
}

function summarize(paths: string[]) {
  const sample = paths.slice(0, 10).join("\n");
  return paths.length > 10 ? `${sample}\n… (${paths.length} total)` : sample;
}

function checkLinks(
  files: ReadonlyMap<string, number>,
  pages: ReturnType<typeof readPages>,
  origin: string,
  aliases: ReadonlyMap<string, string>,
) {
  const aliasTargets = new Map(
    [...aliases].map(([alias, target]) => [pagePath(alias), pagePath(target)]),
  );
  const failures = new Set<string>();
  for (const [page, { links }] of pages) {
    const route = routeFor(page);
    for (const link of links) {
      const url = new URL(link, origin);
      const pathname = decodeURIComponent(url.pathname);
      const targetPath = files.has(pathname)
        ? pathname
        : pagePath(url.pathname);
      const target = pages.get(aliasTargets.get(targetPath) ?? targetPath);
      if (!files.has(targetPath))
        failures.add(`Missing local target: ${route} → ${link}`);
      if (
        target &&
        url.hash &&
        url.hash.toLowerCase() !== "#top" &&
        !target.ids.has(decodeURIComponent(url.hash.slice(1)))
      )
        failures.add(`Missing local fragment: ${route} → ${link}`);
    }
  }
  if (failures.size) throw new Error(summarize([...failures]));
}

function readPages(
  directory: string,
  files: ReadonlyMap<string, number>,
  origin: string,
) {
  const pages = new Map<string, ReturnType<typeof documentInfo>>();
  for (const path of files.keys())
    if (path.endsWith(".html"))
      pages.set(
        path,
        documentInfo(
          readFileSync(join(directory, path), "utf8"),
          routeFor(path),
          origin,
        ),
      );
  return pages;
}

function checkPagefind(
  directory: string,
  files: ReadonlyMap<string, number>,
  expected: Set<string>,
) {
  const missing = new Set(expected);
  for (const path of files.keys()) {
    if (!path.startsWith("/pagefind/fragment/")) continue;
    const fragment = gunzipSync(readFileSync(join(directory, path)), {
      maxOutputLength: 25 * 1024 * 1024,
    });
    const prefix = "pagefind_dcd";
    if (!fragment.subarray(0, prefix.length).equals(Buffer.from(prefix)))
      throw new Error(`Invalid Pagefind fragment: ${path}`);
    const item = JSON.parse(fragment.toString("utf8", prefix.length)) as {
      url?: unknown;
    };
    if (typeof item.url !== "string" || !missing.delete(item.url))
      throw new Error(
        `Unexpected or duplicate Pagefind result: ${String(item.url)}`,
      );
  }
  if (missing.size)
    throw new Error(`Missing Pagefind results:\n${summarize([...missing])}`);
  for (const runtime of [
    "pagefind.js",
    "pagefind-worker.js",
    "pagefind-entry.json",
  ])
    if (files.has(`/pagefind/${runtime}`) !== Boolean(expected.size))
      throw new Error(`Unexpected or missing Pagefind runtime: ${runtime}`);
}

function checkGeneratedLines(path: string, bytes: Buffer) {
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le").decode(bytes)
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? new TextDecoder("utf-16be").decode(bytes)
        : bytes.includes(0)
          ? undefined
          : bytes.toString("utf8");
  if (text !== undefined && physicalLines(text) > 500)
    throw new Error(`Generated text exceeds 500 physical lines: ${path}`);
}

async function certify(directory: string, requireMarker: boolean) {
  const files = readOutput(directory);
  const markerPath = "/" + releaseMarkerPath;
  if (requireMarker && !files.has(markerPath))
    throw new Error(`Missing public file: ${markerPath}`);
  if (!requireMarker && files.has(markerPath))
    throw new Error(`Unexpected public file: ${markerPath}`);
  reportOutput(files);
  const parsedOrigin = outputOrigin(process.env.PORTFOLIO_ORIGIN);
  const pages = readPages(directory, files, parsedOrigin);
  const snapshot = await readProductionNotesSnapshot(
    resolve(notesSnapshotDirectory),
  );
  if (requireMarker) {
    const marker = releaseMarkerFromEnvironment(process.env);
    if (marker.notesSha !== snapshot.receipt.sourceSha)
      throw new Error(
        "Release marker Notes revision differs from the verified snapshot",
      );
    await verifyReleaseMarker(directory, marker);
  }
  if (snapshot.manifest.verifiedCurriculumIds.length)
    throw new Error("The Pages build does not yet render verified curriculum");
  const expected = releaseInventory(snapshot, parsedOrigin);
  const missing = [...expected.canonical.keys()].filter(
    (path) => !pages.has(path),
  );
  const unexpected = [...pages.keys()].filter(
    (path) => !expected.canonical.has(path) && !expected.publicAssets.has(path),
  );
  console.log(
    JSON.stringify({
      ...snapshot.receipt,
      canonicalRoutes: expected.canonical.size - expected.aliases.size,
      aliases: expected.aliases.size,
      missingRoutes: missing.length,
      unexpectedRoutes: unexpected.length,
    }),
  );
  checkLinks(files, pages, parsedOrigin, expected.aliases);
  const searchFiles = verifySearchInventory(
    directory,
    files,
    snapshot.receipt,
    parsedOrigin,
  );
  if (missing.length || unexpected.length)
    throw new Error(
      summarize([
        ...missing.map((path) => `Missing route: ${routeFor(path)}`),
        ...unexpected.map((path) => `Unexpected route: ${routeFor(path)}`),
      ]),
    );
  for (const [path, canonical] of expected.canonical) {
    const { canonicals } = pages.get(path)!;
    if (canonicals.length !== 1 || canonicals[0] !== canonical)
      throw new Error(
        `Canonical differs on ${routeFor(path)}: expected ${canonical}; found ${canonicals.join(", ")}`,
      );
  }
  let anchors = 0;
  for (const entry of snapshot.manifest.entries) {
    const { ids, pdfViewers, pdfDownloads, pdfOpenLinks } = pages.get(
      pagePath(entry.route),
    )!;
    if (
      entry.kind === "pdf" &&
      entry.assetUrl?.startsWith("/content-assets/")
    ) {
      const asset = new URL(entry.assetUrl, parsedOrigin).href;
      if (
        pdfViewers.size !== 1 ||
        !pdfViewers.has(asset) ||
        !pdfDownloads.has(asset) ||
        !pdfOpenLinks.has(asset)
      )
        throw new Error(
          `Local PDF actions differ from the staged snapshot: ${entry.route}`,
        );
    }
    const fragments = new Set([
      ...entry.anchors,
      ...entry.headings.map(({ id }) => id),
    ]);
    for (const id of fragments)
      if (!ids.has(id))
        throw new Error(`Missing snapshot fragment: ${entry.route}#${id}`);
    anchors += fragments.size;
  }

  const pdf = snapshot.manifest.entries.some(
    ({ kind, assetUrl }) =>
      kind === "pdf" && assetUrl?.startsWith("/content-assets/"),
  )
    ? await pdfAssets()
    : new Map<string, Buffer>();
  const required = new Set([
    ...expected.canonical.keys(),
    ...expected.publicAssets.keys(),
    ...[...expected.metadata.keys()].map((path) => "/" + path),
    ...[...pdf.keys()].map((path) => "/pdfjs/" + path),
  ]);
  if (requireMarker) required.add(markerPath);
  for (const path of required)
    if (!files.has(path)) throw new Error(`Missing public file: ${path}`);
  const indexed = new Set(snapshot.manifest.entries.map(({ route }) => route));
  if (!indexed.size && searchFiles.size)
    throw new Error("Pagefind assets are present with no indexed entries");
  for (const path of files.keys()) {
    const source = expected.publicAssets.get(path);
    if (
      !required.has(path) &&
      !astroBundle.test(path) &&
      !searchFiles.has(path)
    )
      throw new Error(`Unexpected public file: ${path}`);
    const bytes = readFileSync(join(directory, path));
    const bound = source
      ? readFileSync(source)
      : pdf.get(path.slice("/pdfjs/".length));
    const metadata = expected.metadata.get(path.slice(1));
    if (bound && !bound.equals(bytes))
      throw new Error(`Public asset bytes differ: ${path}`);
    if (metadata !== undefined && !bytes.equals(Buffer.from(metadata)))
      throw new Error(`Generated metadata differs: ${path}`);
    if (!source) checkGeneratedLines(path, bytes);
    if (path.startsWith("/_astro/") && path.endsWith(".css")) {
      for (const match of bytes
        .toString("utf8")
        .matchAll(/url\(\s*["']?([^"'\s)]+)/gu)) {
        const url = new URL(match[1]!, new URL(path, parsedOrigin));
        if (url.protocol === "data:") continue;
        if (url.origin !== parsedOrigin)
          throw new Error(
            `Cross-origin stylesheet asset: ${path} → ${url.href}`,
          );
        if (!files.has(decodeURIComponent(url.pathname)))
          throw new Error(
            `Missing stylesheet asset: ${path} → ${url.pathname}`,
          );
      }
    }
  }
  checkPagefind(directory, files, indexed);
  console.log(
    `Verified ${anchors} snapshot fragments, ${indexed.size} search results, and ${expected.publicAssets.size + pdf.size} bound assets.`,
  );
}

try {
  const [flag, directory, marker, ...extra] = process.argv.slice(2);
  if (
    flag !== "--dir" ||
    !directory ||
    (marker !== undefined && marker !== "--release-marker") ||
    extra.length
  )
    throw new Error(
      "Usage: npm run verify:output -- --dir dist [--release-marker]",
    );
  await certify(resolve(directory), marker === "--release-marker");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
