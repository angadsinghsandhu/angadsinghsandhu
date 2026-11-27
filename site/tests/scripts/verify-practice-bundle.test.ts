import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  stagePracticeTraces,
  writePracticeTraceAssets,
} from "../../scripts/stage-practice-traces.ts";
import {
  readPracticeBundleForSnapshot,
  readPracticeBundleProof,
  verifyPracticeBundle,
} from "../../scripts/verify-practice-bundle.ts";

const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function withBundle(
  check: (root: string, traceDir: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "portfolio-practice-bundle-"));
  try {
    const traceDir = join(root, "worker-assets/practice-traces");
    await mkdir(traceDir, { recursive: true });
    await mkdir(join(root, "pages"));
    await writeFile(join(root, "pages/index.html"), "<p>Lesson</p>");
    await check(root, traceDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("certifies trace packages listed in Notes lesson order", () =>
  withBundle(async (root, traceDir) => {
    const assets = await Promise.all(
      ["{}", "[]"].map(async (body) => {
        const sha256 = hash(body);
        const name = `${sha256}.json`;
        const file = join(traceDir, name);
        await writeFile(file, body);
        return {
          file,
          sha256,
          bytes: Buffer.byteLength(body),
          publicPath: `/practice-traces/${name}`,
          exportPath: `worker-assets/practice-traces/${name}`,
        };
      }),
    );
    assets.sort((a, b) => b.publicPath.localeCompare(a.publicPath, "en"));
    const expected = await readPracticeBundleProof(root);
    await expect(readPracticeBundleForSnapshot(root, assets)).resolves.toEqual(
      expected,
    );
  }));

test("recomputes both tree digests with the existing staging tuple format", () =>
  withBundle(async (root, traceDir) => {
    const source = join(traceDir, hash("{}") + ".json");
    await writeFile(source, "{}");
    const sibling = await mkdtemp(join(tmpdir(), "portfolio-practice-stage-"));
    try {
      const { mode, sourceSha, manifestSha256, ...expected } =
        await stagePracticeTraces(
          {
            receipt: {
              mode: "preview",
              sourceSha: "a".repeat(40),
              manifestSha256: "b".repeat(64),
            },
            workerAssets: [
              {
                file: source,
                sha256: hash("{}"),
                bytes: 2,
                publicPath: `/practice-traces/${hash("{}")}.json`,
                exportPath: `worker-assets/practice-traces/${hash("{}")}.json`,
              },
            ],
          },
          join(root, "pages"),
          join(sibling, "worker"),
        );
      expect({ mode, sourceSha, manifestSha256 }).toEqual({
        mode: "preview",
        sourceSha: "a".repeat(40),
        manifestSha256: "b".repeat(64),
      });
      expect(await readPracticeBundleProof(root)).toEqual(expected);
      await expect(verifyPracticeBundle(root, expected)).resolves.toEqual(
        expected,
      );
      await expect(
        verifyPracticeBundle(root, { ...expected, workerFiles: 2 }),
      ).rejects.toThrow(/proof/i);
      await writeFile(join(root, "pages/release-marker.json"), '{"run":1}');
      await expect(verifyPracticeBundle(root, expected)).rejects.toThrow(
        /proof/i,
      );
      const withMarker = await readPracticeBundleProof(root);
      expect(withMarker.pagesSha256).not.toBe(expected.pagesSha256);
      expect(withMarker.workerSha256).toBe(expected.workerSha256);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  }));

test.each([
  ["adds another file at the bundle root", "receipt.json"],
  ["adds another worker asset directory", "worker-assets/assets"],
  ["adds a badly named trace", "worker-assets/practice-traces/draft.json"],
])("rejects a bundle that %s", (_name, filename) =>
  withBundle(async (root) => {
    await writeFile(join(root, filename), "{}");
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/layout|path/i);
  }),
);

test("rejects a missing Pages directory", () =>
  withBundle(async (root) => {
    await rm(join(root, "pages"), { recursive: true });
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/layout/i);
  }));

test("rejects links in both output trees", () =>
  withBundle(async (root, traceDir) => {
    const linkedTrace = join(traceDir, hash("{}") + ".json");
    await symlink(join(root, "pages/index.html"), linkedTrace);
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/unsafe/i);
    await rm(linkedTrace);
    await symlink(
      join(root, "pages/index.html"),
      join(root, "pages/link.html"),
    );
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/unsafe/i);
  }));

test("enforces digest, UTF-8, physical lines, and file size for Worker packages", () =>
  withBundle(async (root, traceDir) => {
    const invalid = join(traceDir, hash("{}") + ".json");
    await writeFile(invalid, "[]");
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/digest/i);
    await rm(invalid);
    const invalidUtf8 = Buffer.from([255]);
    const undecodable = join(traceDir, hash(invalidUtf8) + ".json");
    await writeFile(undecodable, invalidUtf8);
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/utf-8/i);
    await rm(undecodable);
    const lines = "{\n" + "\n".repeat(499) + "}\n";
    const oversizedText = join(traceDir, hash(lines) + ".json");
    await writeFile(oversizedText, lines);
    await expect(readPracticeBundleProof(root)).rejects.toThrow(
      /500 physical lines/i,
    );
    await rm(oversizedText);
    await writeFile(invalid, "{}");
    await truncate(invalid, 25 * 1024 * 1024 + 1);
    await expect(readPracticeBundleProof(root)).rejects.toThrow(/size/i);
  }));

test("writes bounded Worker assets independently of the preview guard", () =>
  withBundle(async (root, traceDir) => {
    const body = JSON.stringify({ version: 1 });
    const sha256 = hash(body);
    const path = `practice-traces/${sha256}.json`;
    const file = join(traceDir, sha256 + ".json");
    await writeFile(file, body);
    const worker = join(root, "stage-worker");
    await expect(
      writePracticeTraceAssets(
        [
          {
            file,
            sha256,
            bytes: Buffer.byteLength(body),
            publicPath: "/" + path,
            exportPath: "worker-assets/" + path,
          },
        ],
        worker,
      ),
    ).resolves.toEqual({
      workerFiles: 1,
      workerSha256: hash(
        JSON.stringify([path, Buffer.byteLength(body), sha256]) + "\n",
      ),
    });
  }));
