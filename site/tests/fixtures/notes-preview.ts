import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  importNotesSnapshot,
  notesSnapshotDirectory,
} from "../../src/lib/notes-snapshot.ts";
import {
  portfolioSnapshotV1,
  type PortfolioSnapshotV1,
} from "../../src/lib/notes-snapshot-v1.ts";
import fixture from "./notes-snapshot/manifest.v1.json" with { type: "json" };

export const previewOrigin = "https://portfolio-preview.example";
export const originalRoute = "/notes/books/worked-example/";
export const renamedRoute = "/notes/books/revised-example/";
export const encodedAlias = "/notes/books/worked%20example/";
export const removedRoute = "/notes/interview/removed-example/";
export const addedRoute = "/notes/books/added-example/";

export async function stageSite(workspace: string) {
  for (const path of [
    "astro.config.mjs",
    "package.json",
    "public",
    "scripts",
    "src",
    "tests/fixtures/editorial.ts",
  ])
    await cp(resolve(path), join(workspace, path), { recursive: true });
  // Vite and Astro create caches under node_modules, so share packages only.
  const modules = join(workspace, "node_modules");
  await mkdir(modules);
  for (const name of await readdir(resolve("node_modules"))) {
    if (name.startsWith(".") && name !== ".bin") continue;
    await symlink(resolve("node_modules", name), join(modules, name));
  }
}

export function previewManifest(revised: boolean): PortfolioSnapshotV1 {
  const manifest = portfolioSnapshotV1.parse(fixture);
  const entry = manifest.entries[0]!;
  const id = "doc-" + (revised ? "9" : "8").repeat(64);
  const other = {
    ...entry,
    id,
    aliases: [],
    route: revised ? addedRoute : removedRoute,
    section: revised ? entry.section : ("interview" as const),
    title: revised ? "Added example" : "Removed example",
    ...(!revised
      ? {
          bodyHtml:
            '<h2 id="invariant">Invariant</h2><p id="proof">fixtureexclusivegone</p>',
        }
      : {}),
  };
  if (revised) {
    manifest.sourceSha = "b".repeat(40);
    entry.route = renamedRoute;
    entry.aliases.push(originalRoute);
    entry.bodyHtml =
      '<h2 id="invariant">Invariant</h2><p id="proof">The revised proof is present.</p>';
  } else {
    entry.aliases = [];
  }
  manifest.entries.push(other);
  manifest.organization.memberships.push({
    ...manifest.organization.memberships[0]!,
    entryId: id,
    uid: id,
  });
  return manifest;
}

export async function buildNotesPreview(
  workspace: string,
  name: string,
  manifest: PortfolioSnapshotV1,
) {
  const source = join(workspace, name);
  await mkdir(join(source, "assets"), { recursive: true });
  await mkdir(join(source, "worker-assets/practice-traces"), {
    recursive: true,
  });
  const bytes = JSON.stringify(manifest);
  const receiptPath = join(workspace, `${name}-receipt.json`);
  await writeFile(join(source, "manifest.json"), bytes);
  await writeFile(
    receiptPath,
    JSON.stringify({
      mode: manifest.mode,
      sourceSha: manifest.sourceSha,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  await importNotesSnapshot(
    source,
    join(workspace, notesSnapshotDirectory),
    manifest.sourceSha,
    receiptPath,
  );
  await promisify(execFile)(
    "npm",
    ["run", "build:notes-preview", "--", manifest.sourceSha],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PORTFOLIO_ORIGIN: previewOrigin,
        ASTRO_TELEMETRY_DISABLED: "1",
      },
    },
  );
}
