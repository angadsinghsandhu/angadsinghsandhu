import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

type Manifest =
  import("../src/lib/notes-snapshot.ts").NotesSnapshot["manifest"];

const project = fileURLToPath(new URL("../", import.meta.url));
const importer = join(project, "scripts/import-notes.ts");
const revision = "a".repeat(40);
const fixture = await readFile(
  new URL("fixtures/notes-snapshot/manifest.v1.json", import.meta.url),
  "utf8",
);
const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const pagesBytes = Buffer.from("%PDF-1.7\n%%EOF\n");
const workerBytes = Buffer.from('{"examples":[{"id":"first","steps":[]}]}\n');
const pagesHash = sha256(pagesBytes);
const workerHash = sha256(workerBytes);
const pagesPath = `assets/${pagesHash}.pdf`;
const workerPath = `worker-assets/practice-traces/${workerHash}.json`;
const testPaths = (root: string) => ({
  root,
  tree: join(root, "export"),
  receipt: join(root, "receipt.json"),
  generated: join(root, ".generated/notes"),
});

async function workspace(onTestFinished: (fn: () => Promise<void>) => void) {
  const paths = testPaths(await mkdtemp(join(tmpdir(), "portfolio-notes-")));
  onTestFinished(() => rm(paths.root, { recursive: true, force: true }));
  return paths;
}

function fixtureWithAssets(): Manifest {
  const manifest: Manifest = JSON.parse(fixture);
  manifest.assets.push({
    publicPath: `/content-assets/${pagesHash}.pdf`,
    exportPath: pagesPath,
    bytes: pagesBytes.length,
    sha256: pagesHash,
  });
  manifest.entries[0]!.assetUrl = manifest.assets[0]!.publicPath;

  const problemId = "leetcode:1";
  const traceUrl = `/practice-traces/${workerHash}.json` as const;
  manifest.verifiedCurriculumIds = [1];
  manifest.curriculum.generation = "1".repeat(64);
  manifest.curriculum.problems.push({
    id: problemId,
    number: 1,
    status: "verified",
    title: "Worked problem",
    slug: "worked-problem",
    officialUrl: "https://leetcode.com/problems/worked-problem/",
    domain: "algorithm",
    difficulty: "easy",
    topics: ["arrays"],
    officialQuestionObservedOn: "2026-11-23",
    companies: [],
  });
  manifest.curriculum.lessons.push({
    problemId,
    route: "/practice/leetcode/1/",
    status: "verified",
    bodyHtml: "<p>Worked problem.</p>",
    headings: [],
    approaches: [
      {
        id: "example",
        title: "Example",
        language: "python",
        implementationSha256: "2".repeat(64),
        entryPoint: "solve",
        codeHtml: "<pre>Example</pre>",
        trace: {
          url: traceUrl,
          sha256: workerHash,
          bytes: workerBytes.length,
          exampleIds: ["first"],
        },
        transcripts: [],
      },
    ],
  });
  manifest.curriculum.traceAssets.push({
    publicPath: traceUrl,
    exportPath: workerPath,
    bytes: workerBytes.length,
    sha256: workerHash,
  });
  return manifest;
}

async function writeArtifact(
  paths: ReturnType<typeof testPaths>,
  manifest: Manifest,
  usePinnedBytes = false,
) {
  await mkdir(join(paths.tree, "assets"), { recursive: true });
  await mkdir(join(paths.tree, "worker-assets/practice-traces"), {
    recursive: true,
  });
  if (manifest.assets.length)
    await writeFile(join(paths.tree, pagesPath), pagesBytes);
  if (manifest.curriculum.traceAssets.length)
    await writeFile(join(paths.tree, workerPath), workerBytes);
  const bytes = usePinnedBytes ? fixture : JSON.stringify(manifest) + "\n";
  const receipt = {
    mode: manifest.mode,
    sourceSha: manifest.sourceSha,
    manifestSha256: sha256(bytes),
  };
  await writeFile(join(paths.tree, "manifest.json"), bytes);
  await writeFile(paths.receipt, JSON.stringify(receipt));
  return receipt;
}

const args = (paths: ReturnType<typeof testPaths>) => [
  "--from",
  paths.tree,
  "--revision",
  revision,
  "--receipt",
  paths.receipt,
];

function importArtifact(
  paths: ReturnType<typeof testPaths>,
  options = args(paths),
) {
  return spawnSync(process.execPath, [importer, ...options], {
    cwd: paths.root,
    encoding: "utf8",
  });
}

async function readCurrent(
  paths: ReturnType<typeof testPaths>,
  expected = revision,
) {
  const { readNotesSnapshot } = await import("../src/lib/notes-snapshot.ts");
  return readNotesSnapshot(paths.generated, expected);
}

async function installPinnedFixture(paths: ReturnType<typeof testPaths>) {
  await writeArtifact(paths, JSON.parse(fixture), true);
  const imported = importArtifact(paths);
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
}

it("imports the pinned v1 preview and preserves the encoded alias", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  await installPinnedFixture(paths);
  const snapshot = await readCurrent(paths);
  expect(snapshot.manifest.entries[0]?.aliases).toEqual([
    "/notes/books/worked%20example/",
  ]);
  expect(snapshot.pagesAssets).toEqual([]);
  expect(snapshot.workerAssets).toEqual([]);
  await expect(readCurrent(paths, "b".repeat(40))).rejects.toThrow(/revision/i);
});

it("imports separate Pages and Worker allowlists and can retry the same input", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  const receipt = await writeArtifact(paths, fixtureWithAssets());
  expect(importArtifact(paths).stderr).toBe("");
  const snapshot = await readCurrent(paths);
  expect(snapshot.manifest.curriculum.generation).toBe("1".repeat(64));
  expect(snapshot.pagesAssets.map(({ publicPath }) => publicPath)).toEqual([
    `/content-assets/${pagesHash}.pdf`,
  ]);
  expect(snapshot.workerAssets.map(({ publicPath }) => publicPath)).toEqual([
    `/practice-traces/${workerHash}.json`,
  ]);
  await expect(readFile(snapshot.pagesAssets[0]!.file)).resolves.toEqual(
    pagesBytes,
  );
  await expect(readFile(snapshot.workerAssets[0]!.file)).resolves.toEqual(
    workerBytes,
  );
  expect(importArtifact(paths).stderr).toBe("");
  expect((await readCurrent(paths)).pagesAssets).toEqual(snapshot.pagesAssets);
  expect(
    (await readdir(paths.generated)).filter((name) =>
      name.includes(receipt.manifestSha256),
    ),
  ).toHaveLength(1);
});

const receiptFailures = [
  {
    name: "missing receipt",
    expected: /usage.*--receipt/i,
    run: async (paths: ReturnType<typeof testPaths>) =>
      importArtifact(paths, args(paths).slice(0, -2)),
  },
  {
    name: "missing manifest digest",
    expected: /receipt.*manifestSha256/is,
    run: async (paths: ReturnType<typeof testPaths>) => {
      await writeFile(
        paths.receipt,
        JSON.stringify({ mode: "preview", sourceSha: revision }),
      );
      return importArtifact(paths);
    },
  },
  {
    name: "malformed manifest digest",
    expected: /receipt.*manifestSha256/is,
    run: async (paths: ReturnType<typeof testPaths>) => {
      await writeFile(
        paths.receipt,
        JSON.stringify({
          mode: "preview",
          sourceSha: revision,
          manifestSha256: "0".repeat(63),
        }),
      );
      return importArtifact(paths);
    },
  },
  {
    name: "digest mismatch before JSON parsing",
    expected: /manifest.*digest/i,
    run: async (paths: ReturnType<typeof testPaths>) => {
      await writeFile(join(paths.tree, "manifest.json"), "{");
      return importArtifact(paths);
    },
  },
  {
    name: "abbreviated CLI revision",
    expected: /revision/i,
    run: async (paths: ReturnType<typeof testPaths>) =>
      importArtifact(
        paths,
        args(paths).map((x) => (x === revision ? x.slice(0, 8) : x)),
      ),
  },
  {
    name: "different receipt revision",
    expected: /receipt.*revision/i,
    run: async (paths: ReturnType<typeof testPaths>) =>
      importArtifact(
        paths,
        args(paths).map((x) => (x === revision ? "b".repeat(40) : x)),
      ),
  },
  {
    name: "different manifest revision",
    expected: /manifest.*revision/i,
    run: async (paths: ReturnType<typeof testPaths>) => {
      const manifest = fixtureWithAssets();
      manifest.sourceSha = "b".repeat(40);
      const receipt = await writeArtifact(paths, manifest);
      await writeFile(
        paths.receipt,
        JSON.stringify({ ...receipt, sourceSha: revision }),
      );
      return importArtifact(paths);
    },
  },
  {
    name: "different receipt mode",
    expected: /manifest.*mode/i,
    run: async (paths: ReturnType<typeof testPaths>) => {
      const receipt = await writeArtifact(paths, fixtureWithAssets());
      await writeFile(
        paths.receipt,
        JSON.stringify({ ...receipt, mode: "production" }),
      );
      return importArtifact(paths);
    },
  },
];
it.for(receiptFailures)(
  "rejects $name and preserves the current snapshot",
  async ({ name, expected, run }, { onTestFinished }) => {
    const paths = await workspace(onTestFinished);
    await installPinnedFixture(paths);
    const staged = testPaths(join(paths.root, "candidate"));
    await writeArtifact(staged, fixtureWithAssets());
    const result = await run({ ...staged, root: paths.root });
    expect(result.status, name).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect((await readCurrent(paths)).manifest.assets).toEqual([]);
  },
);

const manifestFailures: Array<[string, RegExp, (manifest: Manifest) => void]> =
  [
    [
      "wrong schema version",
      /schemaVersion/i,
      (manifest) => {
        Object.assign(manifest, { schemaVersion: 2 });
      },
    ],
    [
      "draft field",
      /draft/i,
      (manifest) => {
        Object.assign(manifest.entries[0]!, { draft: true });
      },
    ],
    [
      "duplicate archive IDs",
      /Duplicate entry ID/i,
      (manifest) => {
        manifest.entries.push({
          ...manifest.entries[0]!,
          route: "/notes/books/another/",
        });
      },
    ],
    [
      "duplicate normalized alias and canonical routes",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push("/NOTES/books/worked%2Dexample");
      },
    ],
    [
      "archive alias claiming a lesson route",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push("/PRACTICE/leetcode/%31");
      },
    ],
    [
      "a static directory index matching a canonical route",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push(
          "/NOTES/books/worked-example/%69ndex%2Ehtml",
        );
      },
    ],
    [
      "an archive directory index claiming a lesson route",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push("/practice/leetcode/1/index.html");
      },
    ],
    [
      "an archive alias claiming a Pages asset URL",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push(manifest.assets[0]!.publicPath);
      },
    ],
    [
      "an archive alias claiming a Worker trace URL",
      /Duplicate public route/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push(
          manifest.curriculum.traceAssets[0]!.publicPath,
        );
      },
    ],
    [
      "traversal via encoded alias",
      /safe percent escapes/i,
      (manifest) => {
        manifest.entries[0]!.aliases.push("/notes/books/%2e%2e/");
      },
    ],
    [
      "traversal in an asset export path",
      /exportPath/i,
      (manifest) => {
        manifest.assets[0]!.exportPath = `assets/../${pagesHash}.pdf`;
      },
    ],
    [
      "different Pages digest in the asset name",
      /Pages asset digest differs/i,
      (manifest) => {
        manifest.assets[0]!.sha256 = "3".repeat(64);
      },
    ],
    [
      "different verified curriculum IDs",
      /Verified curriculum numbers/i,
      (manifest) => {
        manifest.verifiedCurriculumIds = [2];
      },
    ],
    [
      "missing curriculum generation",
      /missing its verified generation/i,
      (manifest) => {
        manifest.curriculum.generation = null;
      },
    ],
    [
      "a Worker trace that disagrees with the lesson projection",
      /Trace reference does not match/i,
      (manifest) => {
        manifest.curriculum.traceAssets[0]!.bytes += 1;
      },
    ],
    [
      "over-limit asset",
      /bytes/i,
      (manifest) => {
        manifest.assets[0]!.bytes = 25 * 1024 * 1024 + 1;
      },
    ],
  ];
it.for(manifestFailures)(
  "rejects %s and preserves the current snapshot",
  async ([, expected, mutate], { onTestFinished }) => {
    const paths = await workspace(onTestFinished);
    await installPinnedFixture(paths);
    const manifest = fixtureWithAssets();
    mutate(manifest);
    await writeArtifact(paths, manifest);
    const result = importArtifact(paths);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect((await readCurrent(paths)).manifest.assets).toEqual([]);
  },
);

const treeFailures: Array<[string, RegExp, (tree: string) => Promise<void>]> = [
  [
    "unlisted file",
    /unlisted.*tracks\.zip/i,
    (tree) => writeFile(join(tree, "tracks.zip"), "private"),
  ],
  [
    "unlisted empty directory",
    /unlisted.*extra/i,
    async (tree) => {
      await mkdir(join(tree, "extra"));
    },
  ],
  [
    "missing empty inventory directory",
    /missing.*worker-assets\/practice-traces/i,
    async (tree) => {
      await rm(join(tree, workerPath));
      await rm(join(tree, "worker-assets/practice-traces"), {
        recursive: true,
      });
    },
  ],
  [
    "missing Pages file",
    /missing.*assets\//i,
    (tree) => rm(join(tree, pagesPath)),
  ],
  [
    "symlink at manifest.json",
    /unsafe.*manifest\.json/i,
    async (tree) => {
      const destination = join(dirname(tree), "outside-manifest");
      await rename(join(tree, "manifest.json"), destination);
      await symlink(destination, join(tree, "manifest.json"));
    },
  ],
  [
    "symlink for an allowlisted file",
    /unsafe.*assets\//i,
    async (tree) => {
      const destination = join(dirname(tree), "outside-pages");
      await rename(join(tree, pagesPath), destination);
      await symlink(destination, join(tree, pagesPath));
    },
  ],
  [
    "symlink for an inventory directory",
    /unsafe.*worker-assets/i,
    async (tree) => {
      const destination = join(dirname(tree), "outside-worker");
      await rename(join(tree, "worker-assets"), destination);
      await symlink(destination, join(tree, "worker-assets"));
    },
  ],
  [
    "different Pages byte count",
    /size.*assets\//i,
    (tree) => writeFile(join(tree, pagesPath), "short"),
  ],
  [
    "different Pages contents at the correct size",
    /digest.*assets\//i,
    (tree) => writeFile(join(tree, pagesPath), Buffer.alloc(pagesBytes.length)),
  ],
  [
    "different Worker contents at the correct size",
    /digest.*worker-assets\//i,
    (tree) =>
      writeFile(join(tree, workerPath), Buffer.alloc(workerBytes.length)),
  ],
];
it.for(treeFailures)(
  "rejects %s and preserves the current snapshot",
  async ([, expected, mutateTree], { onTestFinished }) => {
    const paths = await workspace(onTestFinished);
    await installPinnedFixture(paths);
    await writeArtifact(paths, fixtureWithAssets());
    await mutateTree(paths.tree);
    const result = importArtifact(paths);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect((await readCurrent(paths)).manifest.assets).toEqual([]);
  },
);

it("preserves the previous snapshot when killed before promotion and can retry", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  await installPinnedFixture(paths);
  await writeArtifact(paths, fixtureWithAssets());
  const hook = join(paths.root, "pause-before-promotion.mjs");
  await writeFile(
    hook,
    `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to.endsWith("/current.json")) {
        setInterval(() => {}, 1000);
        process.send("ready");
        await new Promise(() => {});
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
  `,
  );
  const child = spawn(
    process.execPath,
    ["--import", hook, importer, ...args(paths)],
    {
      cwd: paths.root,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const closed = once(child, "close");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await closed;
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const checkpoint = await Promise.race([
    once(child, "message").then(([message]) => message),
    closed.then(() => stderr),
  ]);
  expect(checkpoint).toBe("ready");
  child.kill("SIGKILL");
  expect(await closed).toEqual([null, "SIGKILL"]);
  expect((await readCurrent(paths)).manifest.assets).toEqual([]);
  expect(importArtifact(paths).stderr).toBe("");
  expect((await readCurrent(paths)).manifest.assets).toHaveLength(1);
});

async function runRelease(root: string, args: string[] = []) {
  for (const name of ["scripts", "node_modules"]) {
    await symlink(join(project, name), join(root, name));
  }
  await writeFile(
    join(root, "package.json"),
    await readFile(join(project, "package.json")),
  );
  await mkdir(join(root, "src/pages/notes/books"), { recursive: true });
  await mkdir(join(root, "public"));
  await symlink(join(project, "src/lib"), join(root, "src/lib"));
  await writeFile(
    join(root, "astro.config.mjs"),
    await readFile(join(project, "astro.config.mjs")),
  );
  await writeFile(
    join(root, "src/pages/index.astro"),
    '<html lang="en"><body><h1>Portfolio fixture</h1></body></html>',
  );
  await writeFile(
    join(root, "src/pages/notes/books/worked-example.astro"),
    '<html lang="en"><body><article data-pagefind-body>Published worked example.</article></body></html>',
  );
  return spawnSync("npm", ["run", "build:release", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PORTFOLIO_ORIGIN: "https://portfolio.example" },
  });
}

it("denies a release build with no imported snapshot", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  const result = await runRelease(paths.root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/import.*snapshot/i);
  await expect(stat(join(paths.root, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("denies a release build when the snapshot is verified preview material", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  await installPinnedFixture(paths);
  const result = await runRelease(paths.root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/preview.*release/i);
  await expect(stat(join(paths.root, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("publishes only Pages inventory from a verified production snapshot", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  const manifest = fixtureWithAssets();
  manifest.mode = "production";
  manifest.verifiedCurriculumIds = [];
  manifest.curriculum.problems = [];
  manifest.curriculum.lessons = [];
  manifest.curriculum.traceAssets = [];
  await writeArtifact(paths, manifest);
  expect(importArtifact(paths).stderr).toBe("");
  const result = await runRelease(paths.root);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const output = join(paths.root, "dist");
  expect(await readdir(output)).toEqual([
    "_redirects",
    "content-assets",
    "index.html",
    "licenses",
    "notes",
    "pagefind",
    "sitemap.xml",
  ]);
  const inventory = JSON.parse(
    await readFile(
      join(paths.root, ".generated/pages-search-inventory.json"),
      "utf8",
    ),
  );
  expect(inventory).toMatchObject({
    mode: "production",
    sourceSha: manifest.sourceSha,
    origin: "https://portfolio.example",
    files: {
      "/pagefind/pagefind.js": expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  });
  expect(await readdir(join(output, "content-assets"))).toEqual([
    `${pagesHash}.pdf`,
  ]);
  expect(
    await readFile(join(output, "content-assets", `${pagesHash}.pdf`)),
  ).toEqual(pagesBytes);
}, 30_000);

it("denies production lessons until their checked Worker assets can be deployed", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  const manifest = fixtureWithAssets();
  manifest.mode = "production";
  await writeArtifact(paths, manifest);
  expect(importArtifact(paths).stderr).toBe("");
  const result = await runRelease(paths.root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Curriculum release requires checked Worker asset deployment",
  );
  await expect(stat(join(paths.root, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("stages verified production trace bytes only in an explicit paired release", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  const manifest = fixtureWithAssets();
  manifest.mode = "production";
  await writeArtifact(paths, manifest);
  expect(importArtifact(paths).stderr).toBe("");
  const result = await runRelease(paths.root, ["--", "--paired"]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const generated = join(paths.root, ".generated");
  const stage = (await readdir(generated)).filter((path) =>
    path.startsWith("practice-release-"),
  );
  expect(stage).toHaveLength(1);
  const bundle = join(generated, stage[0]!);
  expect(await readdir(bundle)).toEqual(["pages", "worker-assets"]);
  expect(await readFile(join(bundle, workerPath))).toEqual(workerBytes);
  await expect(stat(join(bundle, "pages", workerPath))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(paths.root, "dist"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 30_000);

it("rejects preview snapshots even in explicit paired release mode", async ({
  onTestFinished,
}) => {
  const paths = await workspace(onTestFinished);
  await writeArtifact(paths, fixtureWithAssets());
  expect(importArtifact(paths).stderr).toBe("");
  const result = await runRelease(paths.root, ["--", "--paired"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/preview.*release/i);
});
