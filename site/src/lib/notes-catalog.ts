import { resolve } from "node:path";
import { buildFolders, folderRoute } from "./notes-folders.ts";
import { buildOrganizationIndex } from "./notes-organization.ts";
import {
  compareSourcePaths,
  isLearningNote,
  isReaderNote,
  sourceLabel,
} from "./notes-paths.ts";
import {
  notesSnapshotDirectory,
  readPinnedNotesManifest,
} from "./notes-snapshot.ts";
import {
  readerOrganization,
  type ReaderOrganization,
} from "./notes-organization-pages.ts";
import type { ContentEntry, Section } from "./notes-types.ts";
import type { PortfolioSnapshotV1 } from "./notes-snapshot-v1.ts";

export { sectionLabels, isLearningNote } from "./notes-paths.ts";
export type { LibraryNode } from "./notes-organization.ts";

export type ReaderProps = {
  entry: ContentEntry;
  html: string;
  organization: ReaderOrganization;
  navItems: ContentEntry[];
  assetBytes?: number;
  previous?: ContentEntry;
  next?: ContentEntry;
};

export function createNotesCatalog(manifest?: PortfolioSnapshotV1) {
  const entries = [...(manifest?.entries ?? [])].sort(
    (a, b) =>
      compareSourcePaths(a.section, b.section) ||
      compareSourcePaths(
        a.groupSegments.join("/"),
        b.groupSegments.join("/"),
      ) ||
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      compareSourcePaths(sourceLabel(a), sourceLabel(b)) ||
      compareSourcePaths(a.route, b.route),
  );
  const organization = buildOrganizationIndex(
    entries,
    manifest?.organization ?? {
      topics: [],
      collections: [],
      groups: [],
      paths: [],
      memberships: [],
    },
  );
  const folders = buildFolders(entries);
  const assetSizes = new Map(
    manifest?.assets.map(({ publicPath, bytes }) => [publicPath, bytes]),
  );
  const folderKey = (entry: ContentEntry) =>
    folderRoute(entry.section, entry.groupSegments);
  const neighbors = new Map<string, ContentEntry[]>();
  const noteBuckets = new Map<string, ContentEntry[]>();
  for (const entry of entries.filter(isReaderNote)) {
    const key = folderKey(entry);
    const all = noteBuckets.get(key) ?? [];
    all.push(entry);
    noteBuckets.set(key, all);
    if (isLearningNote(entry)) {
      const learning = neighbors.get(key) ?? [];
      learning.push(entry);
      neighbors.set(key, learning);
    }
  }
  return {
    available: !!manifest,
    folders,
    organization,
    organizationRoutes: organization.routes,
    listEntries: (filters?: { section?: Section }) =>
      filters?.section
        ? entries.filter((entry) => entry.section === filters.section)
        : entries,
    readerPaths(prefix: "/notes/" | "/resources/") {
      return entries
        .filter(({ route }) => route.startsWith(prefix))
        .map((entry) => {
          const key = folderKey(entry);
          const navItems =
            (isReaderNote(entry) ? neighbors : noteBuckets).get(key) ?? [];
          const current = navItems.indexOf(entry);
          const previous = navItems[current - 1];
          const next = current >= 0 ? navItems[current + 1] : undefined;
          const assetBytes = assetSizes.get(entry.assetUrl ?? "");
          const props: ReaderProps = {
            entry,
            organization: readerOrganization(organization, entry),
            html: entry.bodyHtml ?? "",
            navItems,
            ...(assetBytes !== undefined ? { assetBytes } : {}),
            ...(previous ? { previous } : {}),
            ...(next ? { next } : {}),
          };
          return {
            params: { slug: entry.route.slice(prefix.length, -1) },
            props,
          };
        });
    },
  };
}

let preparedManifest: Promise<PortfolioSnapshotV1 | undefined> | undefined;
let preparedCatalog: Promise<ReturnType<typeof createNotesCatalog>> | undefined;

export function readPreparedNotesManifest() {
  const receipt = process.env.PORTFOLIO_NOTES_BUILD_RECEIPT;
  return (preparedManifest ??= receipt
    ? readPinnedNotesManifest(resolve(notesSnapshotDirectory), receipt)
    : Promise.resolve(undefined));
}

export function readPreparedCatalog() {
  return (preparedCatalog ??=
    readPreparedNotesManifest().then(createNotesCatalog));
}
