import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("../../", import.meta.url));

function runCheck(script, path, source) {
  const result = spawnSync(
    "npm",
    ["run", script, "--", "--stdin", "--stdin-filename", path],
    {
      cwd: site,
      encoding: "utf8",
      input: source,
    },
  );
  if (result.error) throw result.error;
  return result;
}

test("lint catches an undefined name in tooling", () => {
  const { status, stdout, stderr } = runCheck(
    "lint",
    "scripts/quality-fixture.mjs",
    "missingFunction();",
  );
  assert.equal(status, 1, stdout + stderr);
  assert.match(stdout, /no-undef/u);
});

for (const script of ["lint", "check:boundaries"]) {
  test(`${script} rejects imports across Portfolio boundaries`, () => {
    const fixtures = [
      [
        "src/client/quality-fixture.ts",
        'import "node:crypto";',
        /no-restricted-imports/u,
      ],
      [
        "src/client/quality-fixture.ts",
        "void import(`node:fs`);",
        /no-restricted-syntax/u,
      ],
      [
        "src/client/quality-fixture.ts",
        'void import("../lib/notes-catalog.ts");',
        /no-restricted-syntax/u,
      ],
      [
        "src/client/quality-fixture.ts",
        'export type Catalog = typeof import("../lib/notes-catalog.ts");',
        /no-restricted-syntax/u,
      ],
      [
        "src/pages/quality-fixture.astro",
        '---\nimport "fs/promises";\n---\n<p>Fixture</p>',
        /no-restricted-imports/u,
      ],
      [
        "src/components/quality-fixture.astro",
        '---\nimport "../../scripts/import-notes.ts";\n---\n<p>Fixture</p>',
        /no-restricted-imports/u,
      ],
      [
        "src/layouts/quality-fixture.astro",
        '---\nvoid import("../../.generated/notes/current.json");\n---\n<p>Fixture</p>',
        /no-restricted-syntax/u,
      ],
      [
        "src/components/quality-fixture.astro",
        '<script>import "../lib/notes-snapshot.ts";</script>',
        /no-restricted-imports/u,
      ],
    ];
    for (const [path, source, rule] of fixtures) {
      const { status, stdout, stderr } = runCheck(script, path, source);
      assert.equal(status, 1, stdout + stderr);
      assert.match(stdout, rule, `${path}: ${stdout + stderr}`);
    }
  });
}
