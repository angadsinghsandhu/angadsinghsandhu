import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("a build in fixture mode still emits approved public content only", (t) => {
  const outDir = mkdtempSync(".install-fixture-build-test-");
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  execFileSync(
    process.execPath,
    [
      "node_modules/astro/bin/astro.mjs",
      "build",
      "--mode",
      "fixtures",
      "--outDir",
      outDir,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "development",
        ASTRO_TELEMETRY_DISABLED: "1",
      },
    },
  );

  for (const route of [
    "projects/fixture-project",
    "music/fixture-release",
    "fixtures/audio",
  ]) {
    assert.equal(existsSync(join(outDir, route)), false, route);
  }
  assert.doesNotMatch(
    readFileSync(join(outDir, "projects/index.html"), "utf8"),
    /Fixture project/u,
  );
  assert.doesNotMatch(
    readFileSync(join(outDir, "music/index.html"), "utf8"),
    /Fixture release/u,
  );
});
