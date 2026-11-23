import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lockJson, readLock } from "./lock.mjs";

const { engines } = JSON.parse(readFileSync("package.json", "utf8"));
if (process.versions.node !== engines.node)
  throw new Error(`Use Node ${engines.node} to install this site`);

const staged = mkdtempSync(".install-");
const previous = join(staged, "previous-node_modules");
let preservePrevious = false;
try {
  copyFileSync("package.json", join(staged, "package.json"));
  writeFileSync(
    join(staged, "package-lock.json"),
    lockJson(readLock("dependency-lock")),
  );
  execFileSync(
    process.execPath,
    [process.env.npm_execpath, "ci", "--no-audit", "--no-fund"],
    {
      cwd: staged,
      stdio: "inherit",
    },
  );

  if (existsSync("node_modules")) renameSync("node_modules", previous);
  try {
    renameSync(join(staged, "node_modules"), "node_modules");
  } catch (error) {
    if (existsSync(previous)) {
      try {
        renameSync(previous, "node_modules");
      } catch (restoreError) {
        preservePrevious = true;
        throw new AggregateError(
          [error, restoreError],
          `Previous dependencies kept at ${previous}`,
        );
      }
    }
    throw error;
  }
} finally {
  if (!preservePrevious) rmSync(staged, { recursive: true, force: true });
}
