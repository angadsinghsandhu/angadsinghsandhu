import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const limit = 500;
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trimEnd();
const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);

function isTestModule(path, source) {
  // Match the discovery scope of test:unit and playwright.config.ts.
  if (!path.startsWith("site/tests/")) return false;
  const runner = path.endsWith(".test.mjs")
    ? "node:test"
    : path.endsWith(".spec.ts")
      ? "@playwright/test"
      : undefined;
  if (!runner) return false;

  const imports = source.matchAll(
    /^[\t ]*import\b[^;]*?\bfrom\s+["']([^"']+)["']/gmu,
  );
  return (
    [...imports].some((match) => match[1] === runner) &&
    /\b(?:test|it|describe)(?:\.[a-z]+)?\s*\(/u.test(source)
  );
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes);
  return bytes.includes(0) ? undefined : new TextDecoder().decode(bytes);
}

const failures = [];
for (const path of new Set(paths.split("\0").filter(Boolean))) {
  const file = join(root, path);
  if (!existsSync(file) || !lstatSync(file).isFile()) continue;

  const source = decodeText(readFileSync(file));
  if (!source) continue;

  const separators = source.match(/\r\n|[\r\n]/gu);
  const count = (separators?.length ?? 0) + (/[\r\n]$/u.test(source) ? 0 : 1);
  if (count > limit && !isTestModule(path, source))
    failures.push(`${path}: ${count} lines`);
}

if (failures.length) {
  console.error(`Files over ${limit} lines:\n${failures.sort().join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`All non-test text files are at or below ${limit} lines.`);
}
