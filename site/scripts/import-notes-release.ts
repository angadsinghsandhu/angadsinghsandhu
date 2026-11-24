import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { outputOrigin } from "./notes-redirects.ts";
import { releaseInventory } from "./output-inventory.ts";
import {
  copyNotesPagesAssets,
  notesSnapshotDirectory,
  readNotesSnapshot,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";

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
  const origin = outputOrigin(process.env.PORTFOLIO_ORIGIN);
  const { metadata } = releaseInventory(snapshot, origin);
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
  for (const [filename, content] of metadata)
    await writeFile(join(output, filename), content, { flag: "wx" });
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
