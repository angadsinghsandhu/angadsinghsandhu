import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  importNotesSnapshot,
  notesSnapshotDirectory,
} from "../src/lib/notes-snapshot.ts";

try {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      revision: { type: "string" },
      receipt: { type: "string" },
    },
  });
  if (!values.from || !values.revision || !values.receipt)
    throw new Error(
      "Usage: import:notes -- --from <staging-dir> --revision <sha> --receipt <path>",
    );
  const receipt = await importNotesSnapshot(
    resolve(values.from),
    resolve(notesSnapshotDirectory),
    values.revision,
    resolve(values.receipt),
  );
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
