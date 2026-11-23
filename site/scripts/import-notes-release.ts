import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  approved,
  indexes,
  projects,
  releases,
} from "../src/content/editorial.ts";
import { claimNotesRoutes } from "../src/lib/notes-routes.ts";
import {
  copyNotesPagesAssets,
  notesSnapshotDirectory,
  readNotesSnapshot,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";

async function portfolioRoutes() {
  const routes = new Set([
    "/",
    "/projects/",
    "/music/",
    "/resume/",
    "/interview/",
    "/404.html",
    "/sitemap.xml",
    ...Object.keys(indexes)
      .filter((index) => index !== "library")
      .map((index) => `/${index}/`),
    ...approved(projects).map(({ slug }) => `/projects/${slug}/`),
    ...approved(releases).map(({ slug }) => `/music/${slug}/`),
  ]);
  const directory = resolve("public");
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  for (const file of files)
    if (file.isFile())
      routes.add(`${file.parentPath.slice(directory.length)}/${file.name}`);
  return routes;
}

try {
  const [mode, revision, ...extra] = process.argv.slice(2);
  const preview = mode === "--preview" && !!revision && !extra.length;
  if (mode && !preview)
    throw new Error(
      "Usage: npm run build:release or npm run build:notes-preview -- <Notes revision>",
    );
  const directory = resolve(notesSnapshotDirectory);
  const snapshot = preview
    ? await readNotesSnapshot(directory, revision)
    : await readProductionNotesSnapshot(directory);
  claimNotesRoutes(snapshot, await portfolioRoutes());
  const localPdf = snapshot.manifest.entries.some(
    ({ kind, assetUrl }) =>
      kind === "pdf" && assetUrl?.startsWith("/content-assets/"),
  );
  const output = preview ? ".generated/notes-preview" : "dist";
  execFileSync("npm", ["run", "build", "--", "--outDir", output], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORTFOLIO_NOTES_BUILD_RECEIPT: JSON.stringify(snapshot.receipt),
      PORTFOLIO_NOTES_LOCAL_PDF: localPdf ? "1" : "0",
    },
  });
  await copyNotesPagesAssets(snapshot, resolve(output));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
