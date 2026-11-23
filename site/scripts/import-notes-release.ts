import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  copyNotesPagesAssets,
  notesSnapshotDirectory,
  readProductionNotesSnapshot,
} from "../src/lib/notes-snapshot.ts";

try {
  const snapshot = await readProductionNotesSnapshot(
    resolve(notesSnapshotDirectory),
  );
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  await copyNotesPagesAssets(snapshot, resolve("dist"));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
