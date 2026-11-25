import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { outputOrigin } from "./notes-redirects.ts";
import { releaseArtifactIdentity } from "./release-artifact-download.ts";
import { verifyReleaseMarker } from "./release-build-marker.ts";
import type { ReleaseReceipt } from "./release-policy.ts";

const api = "https://api.cloudflare.com/client/v4";
const maxResponseBytes = 1024 * 1024;
const pageSize = 20;
const maxPages = 100;
const timeout = 15_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u);
const metadataPattern =
  /^portfolio:v1:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([0-9a-f]{64})(?![\s\S])/u;
const config = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}(?![\s\S])/u),
  projectName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/u),
  productionBranch: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}(?![\s\S])/u),
  origin: z.string(),
  token: z.string().regex(/^[a-zA-Z0-9_-]{1,256}(?![\s\S])/u),
});
const receiptSchema = releaseArtifactIdentity
  .extend({
    notesSha: releaseArtifactIdentity.shape.portfolioSha,
    snapshotSchema: z.number().int().positive(),
    manifestSha256: releaseArtifactIdentity.shape.archiveSha256,
  })
  .strict();
const providerResponse = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()).length(0),
  result: z.unknown(),
  result_info: z.unknown().optional(),
});
const project = z.object({ name: z.string(), production_branch: z.string() });
const deployment = z.object({
  id: uuid,
  project_name: z.string(),
  environment: z.enum(["production", "preview"]),
  deployment_trigger: z.object({
    type: z.enum(["ad_hoc", "github:push", "deploy_hook"]),
    metadata: z.object({
      branch: z.string(),
      commit_hash: z.string(),
      commit_message: z.string(),
      commit_dirty: z.boolean(),
    }),
  }),
  is_skipped: z.boolean(),
  latest_stage: z.object({
    name: z.enum(["queued", "initialize", "clone_repo", "build", "deploy"]),
    status: z.enum([
      "idle",
      "active",
      "success",
      "failure",
      "canceled",
      "skipped",
    ]),
    ended_on: z.iso.datetime({ offset: true }).nullable(),
  }),
});
const deploymentPage = z.array(deployment).max(pageSize);
const pagination = z.object({
  page: z.number().int().positive(),
  per_page: z.literal(pageSize),
  total_count: z.number().int().nonnegative(),
  total_pages: z.number().int().min(0).max(maxPages),
  count: z.number().int().nonnegative(),
});

type Deployment = z.output<typeof deployment>;
type ReceiptRequest = { receipt: ReleaseReceipt };
type DeployRequest = ReceiptRequest & { operationKey: string };
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
) => Promise<boolean>;
type Stage = { directory: string; executable: string };
type Observation =
  | { status: "confirmed"; deploymentId: string }
  | { status: "unknown" | "failed" };
const unknown = { status: "unknown" } as const;

function runWrangler(
  executable: string,
  args: string[],
  options: ExecuteOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    const { timeout, ...spawnOptions } = options;
    const child = spawn(executable, args, { ...spawnOptions, detached: true });
    let timedOut = false;
    // Wrangler's npm executable starts a second Node process.
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !timedOut);
    });
  });
}

function receiptDigest(receipt: ReleaseReceipt): string {
  // Parsing uses a fixed key order so journal serialization order cannot change the identity.
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function checkStage({ directory, executable }: Stage): Promise<void> {
  if (
    !isAbsolute(directory) ||
    (await realpath(directory)) !== directory ||
    !(await stat(directory)).isDirectory() ||
    !isAbsolute(executable) ||
    resolve(executable) !== executable ||
    !(await stat(executable)).isFile()
  )
    throw new Error("Pages paths must name an exact directory and executable");
  await access(executable, constants.X_OK);

  for (const entry of ["_worker.js", "functions"]) {
    if (!(await absent(join(directory, entry))))
      throw new Error("Pages artifact must be static");
  }
  // Wrangler searches above its cwd for configuration and deploy redirects.
  let ancestor = dirname(directory);
  for (;;) {
    for (const entry of [
      ".git",
      ".wrangler",
      "wrangler.toml",
      "wrangler.json",
      "wrangler.jsonc",
    ]) {
      if (!(await absent(join(ancestor, entry))))
        throw new Error("Pages staging must be outside a project");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

function outcome(candidate: Deployment): Observation {
  const { latest_stage: stage } = candidate;
  if (!stage.ended_on || candidate.is_skipped !== (stage.status === "skipped"))
    return unknown;
  if (["failure", "canceled", "skipped"].includes(stage.status)) {
    return { status: "failed" };
  }
  if (stage.name === "deploy" && stage.status === "success") {
    return { status: "confirmed", deploymentId: candidate.id };
  }
  return unknown;
}

export function createReleasePages(
  input: z.input<typeof config> & {
    fetch?: typeof fetch;
    execute?: Execute;
  },
) {
  const parsed = config.safeParse(input);
  if (!parsed.success) throw new Error("Pages configuration is invalid");
  const { accountId, projectName, productionBranch, token } = parsed.data;
  const origin = outputOrigin(parsed.data.origin);
  const { fetch: fetchPages = fetch, execute = runWrangler } = input;
  const projectUrl = `${api}/accounts/${accountId}/pages/projects/${projectName}`;
  const deploymentsUrl = `${projectUrl}/deployments`;

  async function request(
    url: URL,
    method: "GET" | "POST" = "GET",
    signal = AbortSignal.timeout(timeout),
  ) {
    try {
      const response = await fetchPages(url, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      return providerResponse.safeParse(await readBody(response, signal)).data;
    } catch {
      return undefined;
    }
  }

  function matches(
    candidate: Deployment,
    receipt: ReleaseReceipt,
    digest: string,
  ): boolean {
    const { deployment_trigger: trigger } = candidate;
    return (
      candidate.project_name === projectName &&
      candidate.environment === "production" &&
      trigger.type === "ad_hoc" &&
      trigger.metadata.branch === productionBranch &&
      trigger.metadata.commit_hash === receipt.portfolioSha &&
      !trigger.metadata.commit_dirty &&
      metadataPattern.exec(trigger.metadata.commit_message)?.[2] === digest
    );
  }

  async function readExact(
    receipt: ReleaseReceipt,
    deploymentId: string,
    method: "GET" | "POST",
  ) {
    const url = new URL(
      `${deploymentsUrl}/${deploymentId}${method === "POST" ? "/rollback" : ""}`,
    );
    const candidate = deployment.safeParse(
      (await request(url, method))?.result,
    ).data;
    if (
      candidate?.id !== deploymentId ||
      !matches(candidate, receipt, receiptDigest(receipt))
    )
      return undefined;
    return candidate;
  }

  return {
    async deploy(
      { operationKey, receipt: inputReceipt }: DeployRequest,
      stage: Stage,
    ): Promise<{ status: "submitted" | "unknown" }> {
      const receipt = receiptSchema.safeParse(inputReceipt).data;
      if (!receipt || !uuid.safeParse(operationKey).success) return unknown;
      const { directory, executable } = stage;
      try {
        await checkStage({ directory, executable });
        await verifyReleaseMarker(directory, {
          origin,
          portfolioSha: receipt.portfolioSha,
          notesSha: receipt.notesSha,
          runId: receipt.runId,
          runAttempt: receipt.runAttempt,
        });
        const current = project.safeParse(
          (await request(new URL(projectUrl)))?.result,
        ).data;
        if (
          current?.name !== projectName ||
          current.production_branch !== productionBranch
        )
          return unknown;
        const cwd = await mkdtemp(join(dirname(directory), ".pages-release-"));
        try {
          const submitted = await execute(
            executable,
            [
              "pages",
              "deploy",
              directory,
              "--project-name",
              projectName,
              "--branch",
              productionBranch,
              "--commit-hash",
              receipt.portfolioSha,
              "--commit-message",
              `portfolio:v1:${operationKey}:${receiptDigest(receipt)}`,
              "--commit-dirty=false",
              "--experimental-provision=false",
              "--experimental-auto-create=false",
            ],
            {
              cwd,
              shell: false,
              stdio: "ignore",
              timeout: 10 * 60_000,
              env: {
                CI: "true",
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CLOUDFLARE_API_TOKEN: token,
                XDG_CONFIG_HOME: cwd,
                PATH: dirname(process.execPath),
                WRANGLER_SEND_METRICS: "false",
                WRANGLER_SEND_ERROR_REPORTS: "false",
                WRANGLER_LOG_PATH: join(cwd, "wrangler.log"),
              },
            },
          );
          return submitted ? { status: "submitted" } : unknown;
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      } catch {
        return unknown;
      }
    },

    async observe({
      operationKey,
      receipt: inputReceipt,
    }: DeployRequest): Promise<Observation> {
      const receipt = receiptSchema.safeParse(inputReceipt).data;
      if (!receipt || !uuid.safeParse(operationKey).success) return unknown;
      const digest = receiptDigest(receipt);
      const operationMarker = `portfolio:v1:${operationKey}`;
      const signal = AbortSignal.timeout(timeout);
      const seen = new Set<string>();
      let total: number | undefined;
      let candidate: Deployment | undefined;
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(deploymentsUrl);
        // Cloudflare reports total_count across all environments.
        url.search = `page=${page}&per_page=${pageSize}`;
        const response = await request(url, "GET", signal);
        const info = pagination.safeParse(response?.result_info).data;
        const rows = deploymentPage.safeParse(response?.result).data;
        if (
          !rows ||
          !info ||
          info.page !== page ||
          (total !== undefined && info.total_count !== total)
        )
          return unknown;
        total = info.total_count;
        const pages = Math.ceil(total / pageSize);
        if (
          info.count !== rows.length ||
          rows.length !==
            Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize)) ||
          (info.total_pages !== pages &&
            (total !== 0 || info.total_pages !== 1))
        )
          return unknown;
        for (const row of rows) {
          if (seen.has(row.id) || row.project_name !== projectName)
            return unknown;
          seen.add(row.id);
          const message = row.deployment_trigger.metadata.commit_message;
          if (!message.startsWith(operationMarker)) continue;
          if (candidate || !matches(row, receipt, digest)) return unknown;
          candidate = row;
        }
        if (page >= pages) return candidate ? outcome(candidate) : unknown;
      }
      return unknown;
    },

    async readDeployment(
      { receipt: inputReceipt }: ReceiptRequest,
      deploymentId: string,
    ): Promise<Observation> {
      const receipt = receiptSchema.safeParse(inputReceipt).data;
      if (!receipt || !uuid.safeParse(deploymentId).success) return unknown;
      const found = await readExact(receipt, deploymentId, "GET");
      const result = found ? outcome(found) : unknown;
      return result.status === "confirmed" ? result : unknown;
    },

    async rollback(
      { receipt: inputReceipt }: ReceiptRequest,
      deploymentId: string,
    ): Promise<Observation> {
      const receipt = receiptSchema.safeParse(inputReceipt).data;
      if (!receipt || !uuid.safeParse(deploymentId).success) return unknown;
      const prior = await readExact(receipt, deploymentId, "GET");
      if (!prior || outcome(prior).status !== "confirmed") return unknown;
      const restored = await readExact(receipt, deploymentId, "POST");
      if (
        !restored ||
        restored.deployment_trigger.metadata.commit_message !==
          prior.deployment_trigger.metadata.commit_message
      )
        return unknown;
      const result = outcome(restored);
      return result.status === "confirmed" ? result : unknown;
    },
  };
}
