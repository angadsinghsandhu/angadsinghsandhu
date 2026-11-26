import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const scan = () =>
  spawnSync(process.execPath, ["scripts/check-lines.mjs"], {
    encoding: "utf8",
  });
const write = (file, contents) => writeFileSync(file, contents);
const longNodeTest =
  'import test from "node:test";\ntest("exercise", () => {});\n' +
  "\n".repeat(499);
const longVitestTest =
  'import { it } from "vitest";\nit("exercise", () => {});\n' +
  "\n".repeat(499);
const longBrowserTest =
  'import { test } from "@playwright/test";\ntest("exercise", () => {});\n' +
  "\n".repeat(499);

test("checks physical lines of addable text and reports every oversized file", (t) => {
  const directory = mkdtempSync("tests/line-cap-");
  const outsideTests = mkdtempSync("line-cap-");
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outsideTests, { recursive: true, force: true });
  });
  write(join(directory, "lf.txt"), "x\n".repeat(500));
  write(join(directory, "crlf.txt"), "x\r\n".repeat(499) + "x");
  write(join(directory, "integration.test.mjs"), longNodeTest);
  write(join(directory, "integration.spec.ts"), longBrowserTest);
  write(join(directory, "integration.test.ts"), longVitestTest);
  write(
    join(directory, "binary.dat"),
    Buffer.concat([Buffer.from([0]), Buffer.from("\n".repeat(501))]),
  );

  const valid = scan();
  assert.equal(valid.status, 0, valid.stderr);

  write(join(directory, "lf.txt"), "x\n".repeat(501));
  write(join(directory, "crlf.txt"), "x\r\n".repeat(500) + "x");
  write(join(directory, "fixture.test.ts"), "x\n".repeat(501));
  write(join(directory, "fixture.spec.js"), longBrowserTest);
  write(join(directory, "wrong-runner.spec.ts"), longNodeTest);
  write(join(directory, "wrong-runner.test.ts"), longNodeTest);
  write(join(outsideTests, "outside.spec.ts"), longBrowserTest);
  write(
    join(directory, "le.txt"),
    Buffer.from("\uFEFF" + "x\r\n".repeat(501), "utf16le"),
  );
  write(
    join(directory, "be.txt"),
    Buffer.from("\uFEFF" + "x\r\n".repeat(501), "utf16le").swap16(),
  );
  const invalid = scan();
  assert.equal(invalid.status, 1, invalid.stderr);
  for (const file of [
    "lf.txt",
    "crlf.txt",
    "fixture.test.ts",
    "fixture.spec.js",
    "wrong-runner.spec.ts",
    "wrong-runner.test.ts",
    "le.txt",
    "be.txt",
  ]) {
    assert.ok(
      invalid.stderr.includes(`site/${directory}/${file}: 501 lines`),
      invalid.stderr,
    );
  }
  assert.ok(
    invalid.stderr.includes(`site/${outsideTests}/outside.spec.ts: 501 lines`),
    invalid.stderr,
  );
  assert.doesNotMatch(
    invalid.stderr,
    /integration\.(?:test\.mjs|test\.ts|spec\.ts)|binary\.dat/,
  );
});
