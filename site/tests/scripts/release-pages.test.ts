import {
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeReleaseMarker } from "../../scripts/release-build-marker.ts";
import { createReleasePages } from "../../scripts/release-pages.ts";

const target = {
  accountId: "a".repeat(32),
  projectName: "portfolio",
  productionBranch: "main",
  origin: "https://portfolio.example",
  token: "fake-pages-token",
};
const request = {
  operationKey: "12345678-1234-4567-8910-000000000001",
  receipt: {
    portfolioSha: "a".repeat(40),
    notesSha: "b".repeat(40),
    runId: 123,
    runAttempt: 2,
    artifactId: 11,
    manifestSha256: "c".repeat(64),
    archiveSha256: "d".repeat(64),
    snapshotSchema: 1,
  },
};
const deploymentId = "12345678-1234-4567-8910-000000000002";
const projectId = "12345678-1234-4567-8910-000000000005";
const deploymentPath = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/pages/projects/portfolio/deployments`;
const marker = {
  origin: target.origin,
  portfolioSha: request.receipt.portfolioSha,
  notesSha: request.receipt.notesSha,
  runId: request.receipt.runId,
  runAttempt: request.receipt.runAttempt,
};
const commitMessage =
  "portfolio:v1:12345678-1234-4567-8910-000000000001:bb54e8c68fdeff6916ccda0d296c34d7dbfe343d0d684d3fee6baaa1fa2942cb";
const unknown = { status: "unknown" };
const confirmed = { status: "confirmed", deploymentId };

function deployment(changes: Record<string, unknown> = {}) {
  return {
    id: deploymentId,
    project_id: projectId,
    project_name: target.projectName,
    environment: "production",
    deployment_trigger: {
      type: "ad_hoc",
      metadata: {
        branch: "main",
        commit_hash: request.receipt.portfolioSha,
        commit_message: commitMessage,
        commit_dirty: false,
      },
    },
    is_skipped: false,
    latest_stage: {
      name: "deploy",
      status: "success",
      ended_on: "2026-11-24T00:00:00Z",
    },
    ...changes,
  };
}

function envelope(result: unknown, more = {}) {
  return Response.json({ success: true, errors: [], result, ...more });
}

function page(
  rows: ReturnType<typeof deployment>[],
  pageNumber = 1,
  total = rows.length,
) {
  return envelope(rows, {
    result_info: {
      page: pageNumber,
      per_page: 20,
      total_pages: Math.max(1, Math.ceil(total / 20)),
      total_count: total,
      count: rows.length,
    },
  });
}

describe("Pages provider", () => {
  it("observes a unique exact terminal deployment on the fixed API host", async () => {
    const fetchFixture = vi.fn<typeof fetch>(async () => page([deployment()]));
    const pages = createReleasePages({ ...target, fetch: fetchFixture });
    expect(await pages.observe(request)).toEqual(confirmed);
    expect(fetchFixture).toHaveBeenCalledExactlyOnceWith(
      new URL(deploymentPath + "?env=production&page=1&per_page=20"),
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer fake-pages-token" },
      }),
    );
  });

  it("keeps mismatches, duplicate identities, schema drift and nonterminal observations pending", async () => {
    const wrongReceipt = {
      ...request,
      receipt: { ...request.receipt, runAttempt: 3 },
    };
    const rows = [deployment()];
    const cases = [
      [wrongReceipt, page(rows)],
      [request, page([deployment({ environment: "preview" })])],
      [request, page([deployment({ project_name: "another-project" })])],
      [request, page([deployment({ deployment_trigger: null })])],
      [request, page([...rows, deployment({ id: projectId })])],
      [
        request,
        page([
          deployment({
            latest_stage: { name: "deploy", status: "active", ended_on: null },
          }),
        ]),
      ],
      [
        request,
        page([
          deployment({
            latest_stage: {
              name: "deploy",
              status: "future-status",
              ended_on: null,
            },
          }),
        ]),
      ],
      [request, envelope(rows)],
      [request, new Response("sensitive", { status: 302 })],
      [request, new Response("x".repeat(1024 * 1024 + 1))],
    ] as const;
    for (const [expected, response] of cases) {
      const pages = createReleasePages({
        ...target,
        fetch: async () => response,
      });
      expect(await pages.observe(expected)).toEqual(unknown);
    }
  });

  it("requires a validation read and valid POST response for an immutable rollback target", async () => {
    const fetchFixture = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(envelope(deployment()))
      .mockResolvedValueOnce(envelope(deployment()));
    const pages = createReleasePages({ ...target, fetch: fetchFixture });
    expect(
      await pages.rollback({ receipt: request.receipt }, deploymentId),
    ).toEqual(confirmed);
    expect(
      fetchFixture.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      [`${deploymentPath}/${deploymentId}`, "GET"],
      [`${deploymentPath}/${deploymentId}/rollback`, "POST"],
    ]);
  });

  it("does not POST for a missing target and rejects a mismatched POST response", async () => {
    const fetchFixture = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("sensitive", { status: 404 }))
      .mockResolvedValueOnce(envelope(deployment()))
      .mockResolvedValueOnce(envelope(deployment({ id: projectId })));
    const pages = createReleasePages({ ...target, fetch: fetchFixture });
    expect(await pages.rollback(request, deploymentId)).toEqual(unknown);
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    expect(await pages.rollback(request, deploymentId)).toEqual(unknown);
    expect(fetchFixture).toHaveBeenCalledTimes(3);
  });

  it("rejects unsafe targeting inputs and never interpolates an invalid deployment ID", async () => {
    expect(() =>
      createReleasePages({ ...target, accountId: "../wrong" }),
    ).toThrow("Pages configuration is invalid");
    expect(() =>
      createReleasePages({ ...target, projectName: "../wrong" }),
    ).toThrow("Pages configuration is invalid");
    const fetchFixture = vi.fn<typeof fetch>();
    const pages = createReleasePages({ ...target, fetch: fetchFixture });
    expect(await pages.readDeployment(request, "../wrong")).toEqual(unknown);
    expect(
      await pages.observe({ ...request, operationKey: "not-a-uuid" }),
    ).toEqual(unknown);
    expect(fetchFixture).not.toHaveBeenCalled();
  });

  it("submits only a checked static directory from a private cwd, without inheriting tokens", async () => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "pages-assets-"),
    );
    try {
      await writeReleaseMarker(directory, marker);
      const fetchFixture = vi.fn<typeof fetch>(async () =>
        envelope({
          name: target.projectName,
          production_branch: target.productionBranch,
        }),
      );
      const execute: NonNullable<
        Parameters<typeof createReleasePages>[0]["execute"]
      > = async (path, args, options) => {
        expect(path).toBe(process.execPath);
        expect(args).toEqual([
          "pages",
          "deploy",
          directory,
          "--project-name",
          "portfolio",
          "--branch",
          "main",
          "--commit-hash",
          request.receipt.portfolioSha,
          "--commit-message",
          commitMessage,
          "--commit-dirty=false",
          "--experimental-provision=false",
          "--experimental-auto-create=false",
        ]);
        expect(dirname(options.cwd)).toBe(dirname(directory));
        expect(options.cwd).not.toBe(directory);
        expect(await readdir(options.cwd)).toEqual([]);
        expect((await stat(options.cwd)).mode & 0o777).toBe(0o700);
        expect(options).toMatchObject({
          shell: false,
          stdio: "ignore",
        });
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.env).toEqual({
          CI: "true",
          CLOUDFLARE_ACCOUNT_ID: target.accountId,
          CLOUDFLARE_API_TOKEN: target.token,
          XDG_CONFIG_HOME: options.cwd,
          PATH: dirname(process.execPath),
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_SEND_ERROR_REPORTS: "false",
          WRANGLER_LOG_PATH: join(options.cwd, "wrangler.log"),
        });
        return true;
      };
      const runner = vi.fn(execute);
      const pages = createReleasePages({
        ...target,
        fetch: fetchFixture,
        execute: runner,
      });
      const input = { directory, executable: process.execPath };
      expect(await pages.deploy(request, input)).toEqual({
        status: "submitted",
      });
      expect(fetchFixture).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledTimes(1);
      const cwd = runner.mock.calls[0][2].cwd;
      await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await pages.deploy(
          { ...request, receipt: { ...request.receipt, runAttempt: 3 } },
          input,
        ),
      ).toEqual(unknown);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps CLI timeout and errors, and a mismatched provider branch, pending", async () => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "pages-assets-"),
    );
    try {
      await writeReleaseMarker(directory, marker);
      const options = { directory, executable: process.execPath };
      const fetchFixture = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          envelope({ name: target.projectName, production_branch: "wrong" }),
        )
        .mockResolvedValueOnce(
          envelope({ name: target.projectName, production_branch: "main" }),
        )
        .mockResolvedValueOnce(
          envelope({ name: target.projectName, production_branch: "main" }),
        );
      const execute = vi
        .fn<NonNullable<Parameters<typeof createReleasePages>[0]["execute"]>>()
        .mockRejectedValueOnce(new Error("sensitive"))
        .mockResolvedValueOnce(false);
      const pages = createReleasePages({
        ...target,
        fetch: fetchFixture,
        execute,
      });
      expect(await pages.deploy(request, options)).toEqual(unknown);
      expect(execute).not.toHaveBeenCalled();
      expect(await pages.deploy(request, options)).toEqual(unknown);
      expect(await pages.deploy(request, options)).toEqual(unknown);
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("checks all Pages results before claiming exact identity", async () => {
  const unrelated = Array.from({ length: 19 }, (_, index) =>
    deployment({
      id: `12345678-1234-4567-8910-${String(index + 10).padStart(12, "0")}`,
      deployment_trigger: {
        type: "ad_hoc",
        metadata: {
          branch: "main",
          commit_hash: request.receipt.portfolioSha,
          commit_message: "Unrelated upload",
          commit_dirty: false,
        },
      },
    }),
  );
  const fetchFixture = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(page([deployment(), ...unrelated], 1, 21))
    .mockResolvedValueOnce(page([deployment({ id: projectId })], 2, 21))
    .mockResolvedValueOnce(page([deployment(), ...unrelated], 1, 21))
    .mockResolvedValueOnce(
      page(
        [
          deployment({
            id: projectId,
            deployment_trigger: unrelated[0].deployment_trigger,
          }),
        ],
        2,
        21,
      ),
    );
  const pages = createReleasePages({ ...target, fetch: fetchFixture });
  expect(await pages.observe(request)).toEqual(unknown);
  expect(await pages.observe(request)).toEqual(confirmed);
  expect(String(fetchFixture.mock.calls[1][0])).toBe(
    deploymentPath + "?env=production&page=2&per_page=20",
  );
});

it("reports an exact terminal failure while leaving an absent deployment unknown", async () => {
  const fetchFixture = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      page([
        deployment({
          latest_stage: {
            name: "build",
            status: "failure",
            ended_on: "2026-11-24T00:00:00Z",
          },
        }),
      ]),
    )
    .mockResolvedValueOnce(page([]));
  const pages = createReleasePages({ ...target, fetch: fetchFixture });
  expect(await pages.observe(request)).toEqual({ status: "failed" });
  expect(await pages.observe(request)).toEqual(unknown);
});

it("executes a local stand-in directly from an isolated directory", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pages-fixture-"));
  try {
    const directory = await mkdtemp(join(root, "assets-"));
    await writeReleaseMarker(directory, marker);
    const executable = join(root, "fake-wrangler");
    const fetchFixture = vi.fn<typeof fetch>(async () =>
      envelope({
        name: target.projectName,
        production_branch: target.productionBranch,
      }),
    );
    const pages = createReleasePages({ ...target, fetch: fetchFixture });
    await writeFile(
      executable,
      `#!/usr/bin/env node
process.exit(Number(!(
  process.argv[2] === "pages" &&
  process.argv[3] === "deploy" &&
  process.argv[4] === ${JSON.stringify(directory)} &&
  process.env.XDG_CONFIG_HOME === process.cwd() &&
  !process.env.HOME &&
  process.env.CLOUDFLARE_API_TOKEN === "fake-pages-token" &&
  !process.env.GITHUB_TOKEN
)));
`,
      { mode: 0o700 },
    );
    expect(await pages.deploy(request, { directory, executable })).toEqual({
      status: "submitted",
    });
    await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(1);\n");
    expect(await pages.deploy(request, { directory, executable })).toEqual(
      unknown,
    );
    await writeFile(join(root, "wrangler.toml"), "");
    expect(await pages.deploy(request, { directory, executable })).toEqual(
      unknown,
    );
    expect(fetchFixture).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
