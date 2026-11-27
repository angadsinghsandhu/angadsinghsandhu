import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  emptyTraceCatalog,
  traceCatalogPath,
} from "../../scripts/release-trace-inventory.ts";
import { createReleaseTraceProvider } from "../../scripts/release-trace-provider.ts";
import { digestTraceTree } from "../../scripts/stage-practice-traces.ts";

const origin = "https://portfolio.example";
const worker = "portfolio-practice-traces";
const accountId = "a".repeat(32);
const token = "trace-token";
const executable = process.execPath;

async function fixture(
  onTestFinished: (fn: () => Promise<void>) => void,
  frames: number[] = [],
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "trace-provider-"));
  onTestFinished(() => rm(root, { recursive: true }));
  const candidate = join(root, "candidate");
  const bytes = Buffer.from(JSON.stringify({ frames }) + "\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const asset = `practice-traces/${sha}.json`;
  await mkdir(join(candidate, "practice-traces"), { recursive: true });
  await writeFile(join(candidate, asset), bytes);
  const proof = {
    pagesSha256: "b".repeat(64),
    workerFiles: 1,
    workerSha256: digestTraceTree([[asset, bytes.length, sha]]),
  };
  const published = new Map([
    [traceCatalogPath, Buffer.from(emptyTraceCatalog)],
  ]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const file = published.get(url.pathname);
    return file
      ? new Response(new Uint8Array(file))
      : new Response(null, { status: 404 });
  });
  const exec = vi.fn(
    async (
      command: string,
      args: string[],
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        shell: false;
        stdio: "ignore";
        timeout: number;
      },
    ) => {
      expect(command).toBe(executable);
      expect(args).toEqual(["deploy", "--config", "wrangler.json"]);
      expect(options).toMatchObject({ shell: false, stdio: "ignore" });
      expect(Object.keys(options.env).sort()).toEqual([
        "CI",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
        "PATH",
        "WRANGLER_LOG_PATH",
        "WRANGLER_SEND_ERROR_REPORTS",
        "WRANGLER_SEND_METRICS",
        "XDG_CONFIG_HOME",
      ]);
      expect(options.env.CLOUDFLARE_API_TOKEN).toBe(token);
      const config = JSON.parse(
        await readFile(join(options.cwd, "wrangler.json"), "utf8"),
      );
      expect(config).toMatchObject({
        name: worker,
        workers_dev: false,
        preview_urls: false,
      });
      expect(config.routes).toBeUndefined();
      const dir = join(options.cwd, config.assets.directory);
      for (const path of await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (path.isFile()) {
          const file = join(path.parentPath, path.name);
          published.set(file.slice(dir.length), await readFile(file));
        }
      }
      // Simulate a successful activation whose response was lost.
      throw new Error("Response lost");
    },
  );
  return { root, candidate, proof, published, fetch, exec };
}

it("confirms the exact live upload after an ambiguous response and skips a repeat upload", async ({
  onTestFinished,
}) => {
  const f = await fixture(onTestFinished);
  const provider = createReleaseTraceProvider({
    origin,
    accountId,
    token,
    fetch: f.fetch,
    exec: f.exec,
  });
  expect(await provider.probe(f.proof)).toBe(false);
  const stillEligible = vi.fn(async () => true);
  expect(
    await provider.ensure(f.candidate, f.proof, executable, stillEligible),
  ).toBe(true);
  expect(await provider.probe(f.proof)).toBe(true);
  expect(
    await provider.ensure(f.candidate, f.proof, executable, stillEligible),
  ).toBe(true);
  expect(f.exec).toHaveBeenCalledTimes(1);
  expect(await readdir(f.root)).toEqual(["candidate"]);
});

it("declines a changed live catalog immediately before upload", async ({
  onTestFinished,
}) => {
  const f = await fixture(onTestFinished);
  const provider = createReleaseTraceProvider({
    origin,
    accountId,
    token,
    fetch: f.fetch,
    exec: f.exec,
  });
  expect(
    await provider.ensure(f.candidate, f.proof, executable, async () => {
      f.published.set(traceCatalogPath, Buffer.from(emptyTraceCatalog + "\n"));
      return true;
    }),
  ).toBe(false);
  expect(f.exec).not.toHaveBeenCalled();
});

it("denies mutation when ineligible or missing the trace credential", async ({
  onTestFinished,
}) => {
  const f = await fixture(onTestFinished);
  const inputs = { origin, accountId, fetch: f.fetch, exec: f.exec };
  expect(
    await createReleaseTraceProvider(inputs).ensure(
      f.candidate,
      f.proof,
      executable,
      async () => true,
    ),
  ).toBe(false);
  expect(
    await createReleaseTraceProvider({ ...inputs, token }).ensure(
      f.candidate,
      f.proof,
      executable,
      async () => false,
    ),
  ).toBe(false);
  expect(f.exec).not.toHaveBeenCalled();
});

it("does not confirm a success response when the expected catalog never arrives", async ({
  onTestFinished,
}) => {
  const f = await fixture(onTestFinished);
  const exec = vi.fn(async () => true);
  const provider = createReleaseTraceProvider({
    origin,
    accountId,
    token,
    fetch: f.fetch,
    exec,
  });
  expect(
    await provider.ensure(f.candidate, f.proof, executable, async () => true),
  ).toBe(false);
  expect(exec).toHaveBeenCalledOnce();
});

it("refuses a stale staging catalog after an earlier active receipt probe succeeds", async ({
  onTestFinished,
}) => {
  const active = await fixture(onTestFinished);
  const candidate = await fixture(onTestFinished, [1]);
  const provider = createReleaseTraceProvider({
    origin,
    accountId,
    token,
    fetch: active.fetch,
    exec: active.exec,
  });
  const eligible = async () => true;
  expect(
    await provider.ensure(active.candidate, active.proof, executable, eligible),
  ).toBe(true);
  expect(await provider.probe(active.proof)).toBe(true);
  active.published.set(traceCatalogPath, Buffer.from(emptyTraceCatalog));
  expect(
    await provider.ensure(
      candidate.candidate,
      candidate.proof,
      executable,
      eligible,
      active.proof,
    ),
  ).toBe(false);
  expect(active.exec).toHaveBeenCalledOnce();
});
