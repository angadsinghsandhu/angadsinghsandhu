import { posix } from "node:path";
import { buildFolders, flattenFolders } from "./notes-folders.ts";
import { notesLicenseFiles } from "./notes-license-files.ts";
import { buildOrganizationIndex } from "./notes-organization.ts";
import { isReaderNote } from "./notes-paths.ts";
import type { NotesSnapshot } from "./notes-snapshot.ts";

export type RouteClaims = {
  pages: ReadonlyMap<string, string>;
  aliases: ReadonlyMap<string, string>;
};

const libraryPages = [
  "/library/",
  "/library/tree/",
  "/library/topics/",
  "/library/collections/",
  "/library/paths/",
  "/search/",
];
const reserved = [
  "/practice/leetcode",
  "/practice/paths",
  "/practice-traces",
  "/content-assets",
  "/pagefind",
  "/pdfjs",
  "/_astro",
  "/fixtures",
];

export function publicOutputKey(route: string): string {
  return decodeURIComponent(route)
    .normalize("NFC")
    .toLowerCase()
    .replace(/\/+$/u, "")
    .replace(/\/index\.html$/u, "");
}

function assertSafePage(route: string, alias = false): void {
  if (
    !route.startsWith("/") ||
    (alias && !/^\/(?:[a-zA-Z0-9_.%_-]+\/)*[a-zA-Z0-9_.%_-]+\/?$/u.test(route))
  )
    throw new Error(`Invalid Notes route: ${route}`);
  for (const segment of route.replace(/^\/|\/$/gu, "").split("/")) {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      /[/\\%]/u.test(decoded) ||
      [...decoded].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    )
      throw new Error(`Invalid Notes route: ${route}`);
  }
}

export function claimNotesRoutes(
  { manifest }: Pick<NotesSnapshot, "manifest">,
  existing: ReadonlySet<string>,
): RouteClaims {
  const pages = new Map<string, string>();
  const aliases = new Map<string, string>();
  const outputOwners = new Map<string, string>();
  const directories = new Map<string, string>();
  const publicOwners = new Map<string, string>();
  function claim(route: string, owner: string, isPage: boolean) {
    const key = publicOutputKey(route);
    const output = isPage ? `${key}/index.html` : key;
    const previous =
      publicOwners.get(key) ??
      outputOwners.get(output) ??
      directories.get(output);
    if (previous)
      throw new Error(
        `Notes route collision at ${route}: ${previous} and ${owner}`,
      );
    for (
      let directory = posix.dirname(output);
      directory !== "/";
      directory = posix.dirname(directory)
    ) {
      const fileOwner = outputOwners.get(directory);
      if (fileOwner)
        throw new Error(
          `Notes output collision at ${directory}: ${fileOwner} and ${owner} (${route})`,
        );
      directories.set(directory, owner);
    }
    outputOwners.set(output, owner);
    publicOwners.set(key, owner);
  }
  function page(route: string, owner: string) {
    claim(route, owner, true);
    pages.set(route, owner);
  }
  for (const route of existing)
    claim(
      route,
      `Portfolio ${route}`,
      route.endsWith("/") || route.endsWith("/index.html"),
    );
  if (manifest.entries.length)
    for (const { output } of notesLicenseFiles)
      claim("/" + output, "Notes license /" + output, false);
  for (const asset of manifest.assets)
    claim(asset.publicPath, `Notes asset ${asset.publicPath}`, false);
  for (const route of libraryPages) page(route, `Library ${route}`);
  for (const folder of flattenFolders(buildFolders(manifest.entries)))
    page(folder.route, `Folder ${folder.section}/${folder.segments.join("/")}`);
  const organization = buildOrganizationIndex(
    manifest.entries,
    manifest.organization,
  );
  for (const route of organization.routes())
    page(route, `Organization ${route}`);
  for (const entry of manifest.entries) {
    assertSafePage(entry.route);
    const prefix = isReaderNote(entry) ? "/notes/" : "/resources/";
    if (
      !entry.route.startsWith(`${prefix}${entry.section}/`) ||
      !entry.route.endsWith("/")
    )
      throw new Error(
        `Canonical Notes route differs from its reader and section: ${entry.route}`,
      );
    page(entry.route, `Reader ${entry.id}`);
    for (const alias of entry.aliases) {
      assertSafePage(alias, true);
      const key = publicOutputKey(alias);
      if (
        reserved.some(
          (prefix) => key === prefix || key.startsWith(`${prefix}/`),
        )
      )
        throw new Error(`Notes alias uses a reserved namespace: ${alias}`);
      claim(alias, `Alias ${alias} for ${entry.route}`, true);
      aliases.set(alias, entry.route);
    }
  }
  return { pages, aliases };
}
