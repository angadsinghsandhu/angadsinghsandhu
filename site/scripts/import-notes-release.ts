import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { outputOrigin } from "./notes-redirects.ts";
import { releaseInventory, writeSearchInventory } from "./output-inventory.ts";
import {
  stagePracticeTraces,
  writePracticeTraceAssets,
} from "./stage-practice-traces.ts";
import {
  copyNotesPagesAssets,
  notesSnapshotDirectory,
  readNotesSnapshot,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";

try {
  const [mode, revision, ...extra] = process.argv.slice(2);
  const preview = mode === "--preview" && !!revision && !extra.length;
  const paired = mode === "--paired" && !revision && !extra.length;
  if (mode && !preview && !paired)
    throw new Error(
      "Usage: npm run build:release [-- --paired] or npm run build:notes-preview -- <Notes revision>",
    );
  const directory = resolve(notesSnapshotDirectory);
  const snapshot = preview
    ? await readNotesSnapshot(directory, revision)
    : await readProductionNotesSnapshot(directory);
  const hasLessons = snapshot.manifest.verifiedCurriculumIds.length > 0;
  if (
    hasLessons &&
    !paired &&
    (!preview || snapshot.receipt.mode !== "preview")
  )
    throw new Error(
      "Curriculum release requires checked Worker asset deployment",
    );
  if (paired && (!hasLessons || !snapshot.workerAssets.length))
    throw new Error(
      "A paired release requires verified lessons and trace assets",
    );
  const origin = outputOrigin(process.env.PORTFOLIO_ORIGIN);
  const { metadata } = releaseInventory(snapshot, origin);
  const localPdf = snapshot.manifest.entries.some(
    ({ kind, assetUrl }) =>
      kind === "pdf" && assetUrl?.startsWith("/content-assets/"),
  );
  const staging = snapshot.workerAssets.length
    ? await mkdtemp(
        resolve(
          paired
            ? ".generated/practice-release-"
            : ".generated/practice-preview-",
        ),
      )
    : undefined;
  const output = staging
    ? join(staging, "pages")
    : preview
      ? ".generated/notes-preview"
      : "dist";
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
  if (!preview || snapshot.receipt.mode === "preview")
    writeSearchInventory(resolve(output), snapshot.receipt, origin, paired);
  if (staging && paired) {
    await writePracticeTraceAssets(
      snapshot.workerAssets,
      join(staging, "worker-assets"),
    );
    console.log(JSON.stringify({ practiceRelease: staging }));
  } else if (staging) {
    const receipt = await stagePracticeTraces(
      snapshot,
      resolve(output),
      join(staging, "worker-assets"),
    );
    await writeFile(
      join(staging, "receipt.json"),
      JSON.stringify(receipt) + "\n",
      {
        flag: "wx",
      },
    );
    console.log(JSON.stringify({ practicePreview: staging, ...receipt }));
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
