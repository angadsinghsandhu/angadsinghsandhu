import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  importNotesSnapshot,
  notesSnapshotDirectory,
} from "../src/lib/notes-snapshot.ts";
import fixture from "./fixtures/notes-snapshot/manifest.v1.json" with { type: "json" };

let output: string;

beforeEach(() => {
  output = mkdtempSync(join(tmpdir(), "portfolio-output-test-"));
});

afterEach(() => rmSync(output, { recursive: true, force: true }));

function rejectArtifact(
  message: string,
  cwd?: string,
  nodeOptions: string[] = [],
) {
  const result = spawnSync(
    process.execPath,
    [...nodeOptions, resolve("scripts/verify-output.ts"), "--dir", output],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PORTFOLIO_ORIGIN: "https://portfolio.example" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
}

test("rejects an over-limit public file", () => {
  const file = join(output, "oversized.pdf");
  writeFileSync(file, "");
  truncateSync(file, 25 * 1024 * 1024 + 1);
  rejectArtifact("File exceeds 25 MiB: /oversized.pdf");
});

test("rejects too many public files", () => {
  // Stub only this artifact's directory entries, keeping the real CLI and limits.
  const preload = `
    import fs from "node:fs";
    import { dirname } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const root = ${JSON.stringify(output)};
    const { readdirSync, lstatSync } = fs;
    fs.readdirSync = (path, ...args) => path === root
      ? Array.from({ length: 20_001 }, (_, index) => String(index))
      : readdirSync(path, ...args);
    fs.lstatSync = (path, ...args) => dirname(path) === root
      ? { isDirectory: () => false, isFile: () => true, size: 0 }
      : lstatSync(path, ...args);
    syncBuiltinESMExports();
  `;
  rejectArtifact("File count exceeds 20000", undefined, [
    "--import",
    "data:text/javascript," + encodeURIComponent(preload),
  ]);
});

test("rejects a hidden draft payload", () => {
  mkdirSync(join(output, "pagefind", ".draft"), { recursive: true });
  writeFileSync(join(output, "pagefind", ".draft", "lesson.json"), "{}");
  rejectArtifact("Private output path: /pagefind/.draft");
});

async function withProductionSnapshot(use: (workspace: string) => void) {
  const workspace = mkdtempSync(join(tmpdir(), "portfolio-output-workspace-"));
  try {
    const source = join(workspace, "snapshot");
    mkdirSync(join(source, "assets"), { recursive: true });
    mkdirSync(join(source, "worker-assets/practice-traces"), {
      recursive: true,
    });
    mkdirSync(join(workspace, "public"));
    const manifest = JSON.stringify({
      ...fixture,
      mode: "production",
      entries: fixture.entries.map((entry) => ({ ...entry, aliases: [] })),
    });
    writeFileSync(join(source, "manifest.json"), manifest);
    const receipt = join(workspace, "receipt.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        mode: "production",
        sourceSha: fixture.sourceSha,
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      }),
    );
    await importNotesSnapshot(
      source,
      join(workspace, notesSnapshotDirectory),
      fixture.sourceSha,
      receipt,
    );
    use(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("rejects a missing local fragment", async () => {
  await withProductionSnapshot((workspace) => {
    writeFileSync(
      join(output, "index.html"),
      '<a href="#missing">Missing target</a>',
    );
    rejectArtifact("Missing local fragment: / → /#missing", workspace);
  });
});

test("reserves _redirects for generated rules when there are no aliases", async () => {
  await withProductionSnapshot((workspace) => {
    writeFileSync(join(workspace, "public", "_redirects"), "/old/ / 308\n");
    rejectArtifact(
      "Public file uses generated metadata path: /_redirects",
      workspace,
    );
  });
});
