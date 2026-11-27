import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { outputOrigin } from "./notes-redirects.ts";
import {
  probeTraceBundle,
  stageTraceInventory,
  traceCatalogPath,
  verifyPublishedTraceInventory,
  type ReadTraceInventoryFile,
} from "./release-trace-inventory.ts";
import type { PracticeBundleProof } from "./verify-practice-bundle.ts";

export const traceWorkerName = "portfolio-practice-traces";
const tracePath =
  /^\/practice-traces\/(?:_catalog|(?:manifests\/)?[a-f0-9]{64})\.json(?![\s\S])/u;
const readBudget = 10 * 60_000;
const catalogLimit = 4 * 1024 * 1024;

type ExecuteOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: "ignore";
  timeout: number;
};
type Execute = (
  executable: string,
  args: string[],
  options: ExecuteOptions,
) => Promise<unknown>;

function runWrangler(
  executable: string,
  args: string[],
  options: ExecuteOptions,
) {
  return new Promise<void>((done, reject) => {
    const { timeout, ...spawnOptions } = options;
    const child = spawn(executable, args, { ...spawnOptions, detached: true });
    // Wrangler may start another process, so a timeout applies to its process group.
    const timer = setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Trace Worker deployment could not start"));
    });
    child.once("close", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function createReader(
  origin: string,
  request: typeof fetch,
): ReadTraceInventoryFile {
  const deadline = AbortSignal.timeout(readBudget);
  return async (path, maximumBytes) => {
    if (!tracePath.test(path)) throw new Error("Invalid published trace path");
    const url = new URL(path, origin);
    url.searchParams.set("probe", randomUUID());
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(10_000)]);
    const response = await request(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (response.status !== 200 || response.redirected || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Published trace file is unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBytes)
          throw new Error("Published trace file exceeds its byte limit");
        chunks.push(value);
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, length);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  };
}

async function requireExecutable(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !(await stat(path)).isFile()
  )
    throw new Error("Trace Worker deployment requires pinned executable paths");
  await access(path, constants.X_OK);
}

export function createReleaseTraceProvider({
  origin: inputOrigin,
  accountId,
  token,
  nodeExecutable = process.execPath,
  fetch: request = fetch,
  exec = runWrangler,
}: {
  origin: string;
  accountId: string;
  token?: string;
  nodeExecutable?: string;
  fetch?: typeof fetch;
  exec?: Execute;
}) {
  const origin = outputOrigin(inputOrigin);
  if (!/^[a-f0-9]{32}(?![\s\S])/u.test(accountId))
    throw new Error(
      "Trace Worker deployment requires an exact Cloudflare account",
    );

  return {
    async probe(proof: PracticeBundleProof): Promise<boolean> {
      try {
        await probeTraceBundle(proof, createReader(origin, request));
        return true;
      } catch {
        return false;
      }
    },

    async ensure(
      workerDirectory: string,
      proof: PracticeBundleProof,
      wranglerExecutable: string,
      stillEligible: () => Promise<boolean>,
    ): Promise<boolean> {
      if (!token || !/^[!-~]+(?![\s\S])/u.test(token)) return false;

      try {
        if (
          !isAbsolute(workerDirectory) ||
          (await realpath(workerDirectory)) !== workerDirectory ||
          !(await lstat(workerDirectory)).isDirectory()
        )
          return false;
        await requireExecutable(wranglerExecutable);
        await requireExecutable(nodeExecutable);
        const cwd = await mkdtemp(
          join(dirname(workerDirectory), ".trace-release-"),
        );
        try {
          const read = createReader(origin, request);
          const initial = await read(traceCatalogPath, catalogLimit);
          const desired = await stageTraceInventory(
            workerDirectory,
            proof,
            join(cwd, "assets"),
            (path, maximumBytes) =>
              path === traceCatalogPath
                ? Promise.resolve(initial)
                : read(path, maximumBytes),
          );

          if (!initial.equals(desired)) {
            await writeFile(
              join(cwd, "wrangler.json"),
              JSON.stringify({
                name: traceWorkerName,
                compatibility_date: "2026-11-26",
                workers_dev: false,
                preview_urls: false,
                assets: {
                  directory: "./assets",
                  html_handling: "none",
                  not_found_handling: "none",
                },
              }) + "\n",
              { flag: "wx", mode: 0o600 },
            );
            if (!(await stillEligible())) return false;
            if (!(await read(traceCatalogPath, catalogLimit)).equals(initial))
              return false;
            // A lost Wrangler response is ambiguous. Check the live catalog and bytes.
            await exec(
              wranglerExecutable,
              ["deploy", "--config", "wrangler.json"],
              {
                cwd,
                shell: false,
                stdio: "ignore",
                timeout: 10 * 60_000,
                env: {
                  CI: "true",
                  CLOUDFLARE_ACCOUNT_ID: accountId,
                  CLOUDFLARE_API_TOKEN: token,
                  PATH: dirname(nodeExecutable),
                  WRANGLER_LOG_PATH: join(cwd, "wrangler.log"),
                  WRANGLER_SEND_ERROR_REPORTS: "false",
                  WRANGLER_SEND_METRICS: "false",
                  XDG_CONFIG_HOME: cwd,
                },
              },
            ).catch(() => {});
          }

          await verifyPublishedTraceInventory(
            desired,
            createReader(origin, request),
          );
          return true;
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      } catch {
        return false;
      }
    },
  };
}
