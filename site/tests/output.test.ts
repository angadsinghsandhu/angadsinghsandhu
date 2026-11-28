import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  encodeReleaseMarker,
  releaseMarkerPath,
} from "../scripts/release-build-marker.ts";
import {
  importNotesSnapshot,
  notesSnapshotDirectory,
} from "../src/lib/notes-snapshot.ts";
import fixture from "./fixtures/notes-snapshot/manifest.v1.json" with { type: "json" };

let output: string;
const candidate = {
  origin: "https://portfolio.example",
  portfolioSha: "a".repeat(40),
  notesSha: fixture.sourceSha,
  runId: 123,
  runAttempt: 2,
};

beforeEach(() => {
  output = mkdtempSync(join(tmpdir(), "portfolio-output-test-"));
});

afterEach(() => rmSync(output, { recursive: true, force: true }));

function rejectArtifact(
  message: string,
  cwd?: string,
  nodeOptions: string[] = [],
  markerNotesSha?: string,
  progressFlag?: string,
) {
  const result = spawnSync(
    process.execPath,
    [
      ...nodeOptions,
      resolve("scripts/verify-output.ts"),
      "--dir",
      output,
      ...(markerNotesSha ? ["--release-marker"] : []),
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PORTFOLIO_ORIGIN: candidate.origin,
        PORTFOLIO_SHA: candidate.portfolioSha,
        NOTES_REVISION: markerNotesSha,
        GITHUB_RUN_ID: String(candidate.runId),
        GITHUB_RUN_ATTEMPT: String(candidate.runAttempt),
        PORTFOLIO_PRIVATE_PROGRESS_ENABLED: progressFlag,
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  return result.stderr;
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

test("rejects a stray release marker without candidate verification", () => {
  writeFileSync(
    join(output, releaseMarkerPath),
    encodeReleaseMarker(candidate),
  );
  rejectArtifact("Unexpected public file: /portfolio-release.json");
});

test.each(["missing", "mismatched", "wrong Notes revision"] as const)(
  "rejects a candidate marker with %s",
  async (problem) => {
    await withProductionSnapshot((workspace) => {
      const notesSha =
        problem === "wrong Notes revision"
          ? "b".repeat(40)
          : candidate.notesSha;
      if (problem !== "missing") {
        const input =
          problem === "mismatched"
            ? { ...candidate, runAttempt: 3 }
            : { ...candidate, notesSha };
        writeFileSync(
          join(output, releaseMarkerPath),
          encodeReleaseMarker(input),
        );
      }
      const message = {
        missing: "Missing public file: /portfolio-release.json",
        mismatched: "Staged release marker differs from the expected bytes",
        "wrong Notes revision":
          "Release marker Notes revision differs from the verified snapshot",
      }[problem];
      rejectArtifact(message, workspace, [], notesSha);
    });
  },
);

test("rejects a missing local fragment", async () => {
  await withProductionSnapshot((workspace) => {
    writeFileSync(
      join(output, "index.html"),
      [
        '<a href="https://external.example/article">Approved source</a>',
        '<iframe src="https://external.example/media"></iframe>',
        '<a href="#missing">Missing target</a>',
      ].join(""),
    );
    rejectArtifact("Missing local fragment: / → /#missing", workspace);
  });
});

test.each([
  ["practice/leetcode/", undefined, false],
  ["", "true", false],
  ["practice/leetcode/", "true", true],
] as const)(
  "restricts the private Worker link from /%s (flag %s)",
  async (route, flag, allowed) => {
    await withProductionSnapshot((workspace) => {
      mkdirSync(join(output, route), { recursive: true });
      writeFileSync(
        join(output, route, "index.html"),
        '<a href="/account/">Private progress</a><a href="/unexpected/">Missing</a>',
      );
      const errors = rejectArtifact(
        `Missing local target: /${route} → /unexpected/`,
        workspace,
        [],
        undefined,
        flag,
      );
      expect(
        errors.includes(`Missing local target: /${route} → /account/`),
      ).toBe(!allowed);
    });
  },
);

test("reserves _redirects for generated rules when there are no aliases", async () => {
  await withProductionSnapshot((workspace) => {
    writeFileSync(join(workspace, "public", "_redirects"), "/old/ / 308\n");
    rejectArtifact(
      "Public file uses generated metadata path: /_redirects",
      workspace,
    );
  });
});

test.each([
  '<script type="module" src="//external.example/changed.js"></script>',
  '<link rel="stylesheet" href="https://external.example/changed.css">',
  '<link rel="modulepreload" href="https://external.example/changed.js">',
  '<section data-pdf-url="https://external.example/moved.pdf"></section>',
])("rejects a cross-origin owned runtime reference %s", async (markup) => {
  await withProductionSnapshot((workspace) => {
    writeFileSync(join(output, "index.html"), markup);
    rejectArtifact("Cross-origin runtime asset: / → ", workspace);
  });
});

test.each(["missing", "corrupt"] as const)(
  "rejects a %s Pagefind runtime file bound by the private receipt",
  async (damage) => {
    await withProductionSnapshot((workspace) => {
      const path = "/pagefind/index/en_test.pf_index";
      writeFileSync(
        join(workspace, ".generated/pages-search-inventory.json"),
        JSON.stringify({
          ...JSON.parse(
            readFileSync(
              join(workspace, notesSnapshotDirectory, "current.json"),
              "utf8",
            ),
          ),
          origin: "https://portfolio.example",
          files: {
            [path]: createHash("sha256").update("index bytes").digest("hex"),
          },
        }),
      );
      if (damage === "corrupt") {
        mkdirSync(join(output, "pagefind", "index"), { recursive: true });
        writeFileSync(join(output, path), "corrupt bytes");
      }
      rejectArtifact(
        damage === "missing"
          ? `Missing Pagefind file: ${path}`
          : `Pagefind file digest differs: ${path}`,
        workspace,
      );
    });
  },
);
