import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stagePracticeTraces } from "../../scripts/stage-practice-traces.ts";

test("stages only the receipt-bound trace bytes outside the Pages root", async () => {
  const root = await mkdtemp(join(tmpdir(), "portfolio-practice-stage-"));
  try {
    const pages = join(root, "pages");
    const worker = join(root, "worker");
    await mkdir(pages);
    await writeFile(join(pages, "index.html"), "<p>Preview</p>");
    const body = '{"version":1,"traces":[]}';
    const sha256 = createHash("sha256").update(body).digest("hex");
    const source = join(root, "trace-input.json");
    await writeFile(source, body);
    const path = `practice-traces/${sha256}.json`;
    const snapshot = {
      receipt: {
        mode: "preview" as const,
        sourceSha: "a".repeat(40),
        manifestSha256: "b".repeat(64),
      },
      workerAssets: [
        {
          file: source,
          bytes: Buffer.byteLength(body),
          sha256,
          publicPath: "/" + path,
          exportPath: "worker-assets/" + path,
        },
      ],
    };
    const result = await stagePracticeTraces(snapshot, pages, worker);
    expect(result).toMatchObject({
      ...snapshot.receipt,
      workerFiles: 1,
      pagesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      workerSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(await readFile(join(worker, path), "utf8")).toBe(body);
    await expect(readFile(join(pages, path))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(source, body.replace("1", "2"));
    await expect(
      stagePracticeTraces(snapshot, pages, join(root, "bad-worker")),
    ).rejects.toThrow(/digest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
