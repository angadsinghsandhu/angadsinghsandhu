import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("lock parts round-trip npm metadata including integrity hashes", async (t) => {
  const directory = mkdtempSync(".install-lock-test-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packages = {
    "": { name: "round-trip", dependencies: { example: "1.0.0" } },
  };

  for (const id of Array.from({ length: 100 }, (_, index) => index)) {
    packages[`node_modules/example-${id}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/example-${id}/-/example-${id}-1.0.0.tgz`,
      integrity: `sha512-example-integrity-${id}`,
      optional: id % 2 === 0,
      os: ["linux", "darwin"],
    };
  }

  const lock = {
    name: "round-trip",
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  const { readLock, writeLockParts } = await import("../../scripts/lock.mjs");
  writeLockParts(lock, join(directory, "lock"));
  assert.deepEqual(readLock(join(directory, "lock")), lock);

  const files = readdirSync(join(directory, "lock"));
  assert.ok(files.length > 2);
  for (const file of files) {
    const source = readFileSync(join(directory, "lock", file), "utf8");
    assert.ok(source.trimEnd().split("\n").length <= 500, file);
    assert.match(source, /^\{\n/);
  }
});
