import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  encodeReleaseMarker,
  releaseMarkerPath,
} from "../../scripts/release-build-marker.ts";
import {
  coordinateRelease,
  type ReleaseCoordinatorGate,
} from "../../scripts/release-coordinator.ts";
import type { createReleasePages } from "../../scripts/release-pages.ts";
import { runProductionRelease } from "../../scripts/release-production.ts";

type Execute = NonNullable<Parameters<typeof createReleasePages>[0]["execute"]>;
const { execute } = vi.hoisted(() => ({ execute: vi.fn<Execute>() }));
vi.mock(import("../../scripts/release-pages.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createReleasePages: (config: Parameters<typeof createReleasePages>[0]) =>
      actual.createReleasePages({ ...config, execute }),
  };
});
const origin = "https://portfolio.example";
const accountId = "e".repeat(32);
const databaseId = "12345678-abcd-abcd-abcd-123456789abc";
const project = "fixture";
const cloudflare = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const pagesUrl = `${cloudflare}/pages/projects/${project}`;
const repository = {
  id: 339077137,
  full_name: "angadsinghsandhu/angadsinghsandhu",
  default_branch: "main",
};
const notesRepository = { id: 590347468, full_name: "angadsinghsandhu/Notes" };
const repoUrl = (name: string) => `https://api.github.com/repos/${name}`;
const portfolioUrl = repoUrl(repository.full_name);
const notesUrl = repoUrl(notesRepository.full_name);
const workflow = (name: string) =>
  `${repository.full_name}/.github/workflows/portfolio-${name}.yml@refs/heads/main`;
const notesRunAttempt = 3;
const pdfRoute =
  "/resources/classes/johns-hopkins/sem-1/ml-dl/mock-exams/cs482682-mock-exam-fall-2023-pdf/";
const pdfAsset = "/content-assets/" + "f".repeat(64) + ".pdf";

function candidate(
  python: string,
  runId: number,
  portfolioChar: string,
  notesChar: string,
) {
  const identity = {
    portfolioSha: portfolioChar.repeat(40),
    notesSha: notesChar.repeat(40),
    runId,
    runAttempt: 2,
  };
  const marker = encodeReleaseMarker({ origin, ...identity });
  const files = Object.fromEntries(
    ["/", "/library/", "/interview/", "/search/", pdfRoute].map((route) => [
      route + "index.html",
      `<link rel="canonical" href="${origin}${route}"><main data-pdf-url="${pdfAsset}">${runId}</main>`,
    ]),
  );
  const archive = execFileSync(
    python,
    [
      "-c",
      `import json, sys, zipfile
with zipfile.ZipFile(sys.stdout.buffer, "w") as output:
    for path, content in json.loads(sys.argv[1]).items():
        output.writestr(path.removeprefix("/"), content.encode("latin-1"))`,
      JSON.stringify({
        ...files,
        [releaseMarkerPath]: marker.toString("utf8"),
        [pdfAsset]: "%PDF-fixture",
        "/pagefind/pagefind.js": "export {};",
        "/pagefind/pagefind-entry.json":
          '{"languages":{"en":{"hash":"en_1234567890","page_count":1}}}',
        "/pagefind/pagefind.en_1234567890.pf_meta": "\x1f\x8b",
      }),
    ],
    { timeout: 10_000 },
  );
  return {
    receipt: {
      ...identity,
      artifactId: runId + 100,
      snapshotSchema: 1,
      manifestSha256: "b".repeat(64),
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
    },
    notesRunId: runId + 200,
    marker,
    archive,
  };
}

const envelope = (result: unknown) => ({ success: true, errors: [], result });
const deploymentId = (sequence: number) =>
  `10000000-0000-4000-8000-00000000000${sequence}`;

it("rehearses two protected publications and an exact rollback after the first artifact expires", async () => {
  const python = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  ).trim();
  const first = candidate(python, 12, "a", "b");
  const second = candidate(python, 13, "c", "d");
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "production-rehearsal-"),
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      await readFile(
        new URL("../../scripts/release-journal.sql", import.meta.url),
        "utf8",
      ),
    );
    let selected = first;
    let expired = false;
    let serving = "";
    type Deployment = { files: Map<string, Buffer>; metadata: object };
    const deployments = new Map<string, Deployment>();
    const rollbackIds: string[] = [];
    const downloaded: number[] = [];
    const history = () =>
      db.prepare("SELECT * FROM release_operations ORDER BY id").all();
    const projectId = deploymentId(9);
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const { receipt, notesRunId } = selected;
      const href = url.href;
      if (href === portfolioUrl) return Response.json(repository);
      if (href === notesUrl) return Response.json(notesRepository);
      if (
        href === portfolioUrl + "/branches/main" ||
        href === notesUrl + "/branches/main"
      )
        return Response.json({
          name: "main",
          protected: true,
          commit: {
            sha: href.startsWith(portfolioUrl)
              ? receipt.portfolioSha
              : receipt.notesSha,
          },
        });
      const runUrl = `${notesUrl}/actions/runs/${notesRunId}`;
      const check = {
        head_sha: receipt.notesSha,
        status: "completed",
        conclusion: "success",
      };
      if (href === runUrl)
        return Response.json({
          ...check,
          id: notesRunId,
          run_attempt: notesRunAttempt,
          workflow_id: 379127533,
          repository: notesRepository,
          head_repository: notesRepository,
          head_branch: "main",
          event: "push",
        });
      if (href === `${runUrl}/attempts/${notesRunAttempt}/jobs?per_page=100`)
        return Response.json({
          total_count: 1,
          jobs: [
            {
              ...check,
              name: "verify",
              run_id: notesRunId,
              run_attempt: notesRunAttempt,
            },
          ],
        });

      const firstArtifact = `${portfolioUrl}/actions/artifacts/${first.receipt.artifactId}`;
      if (expired && href === firstArtifact)
        return Response.json({ id: first.receipt.artifactId, expired: true });
      const artifact = `${portfolioUrl}/actions/artifacts/${receipt.artifactId}`;
      const signedUrl = `https://fixture.example/${receipt.artifactId}.zip?sig=fixture`;
      if (href === artifact)
        return Response.json({
          id: receipt.artifactId,
          name: `portfolio-candidate-${receipt.runId}-${receipt.runAttempt}`,
          expired: false,
          expires_at: "2099-01-01T00:00:00Z",
          digest: "sha256:" + receipt.archiveSha256,
          workflow_run: {
            id: receipt.runId,
            repository_id: repository.id,
            head_repository_id: repository.id,
            head_branch: "main",
            head_sha: receipt.portfolioSha,
          },
        });
      if (href === artifact + "/zip")
        return new Response(null, {
          status: 302,
          headers: { location: signedUrl },
        });
      if (href === signedUrl) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        downloaded.push(receipt.artifactId);
        return new Response(Uint8Array.from(selected.archive));
      }

      if (href === `${cloudflare}/d1/database/${databaseId}/query`) {
        const { sql, params } = JSON.parse(String(init?.body)) as {
          sql: string;
          params: string[];
        };
        const bindings = Object.fromEntries(
          params.map((parameter, index) => [`?${index + 1}`, parameter]),
        );
        return Response.json(
          envelope([{ success: true, results: db.prepare(sql).all(bindings) }]),
        );
      }
      if (href === pagesUrl)
        return Response.json(
          envelope({
            id: projectId,
            name: project,
            production_branch: "main",
            domains: [new URL(origin).host],
            uses_functions: false,
            canonical_deployment: deployments.get(serving)?.metadata,
          }),
        );
      if (href === pagesUrl + "/deployments?page=1&per_page=20") {
        const rows = [...deployments.values()].map(({ metadata }) => metadata);
        return Response.json({
          ...envelope(rows),
          result_info: {
            page: 1,
            per_page: 20,
            total_pages: 1,
            total_count: rows.length,
            count: rows.length,
          },
        });
      }
      if (href.startsWith(pagesUrl + "/deployments/")) {
        const [id, operation] = href
          .slice((pagesUrl + "/deployments/").length)
          .split("/");
        const deployment = deployments.get(id ?? "");
        if (
          id &&
          deployment &&
          operation === "rollback" &&
          init?.method === "POST"
        ) {
          rollbackIds.push(id);
          serving = id;
        }
        return deployment
          ? Response.json(envelope(deployment.metadata))
          : new Response(null, { status: 404 });
      }
      if (url.origin === origin) {
        const path = url.pathname.endsWith("/")
          ? url.pathname + "index.html"
          : url.pathname;
        const body = deployments.get(serving)?.files.get(path);
        if (!body) return new Response(null, { status: 404 });
        const type = path.endsWith(".html")
          ? "text/html"
          : path.endsWith(".js")
            ? "application/javascript"
            : path.endsWith(".json")
              ? "application/json"
              : path.endsWith(".pdf")
                ? "application/pdf"
                : "application/octet-stream";
        return new Response(Uint8Array.from(body), {
          headers: { "content-type": type },
        });
      }
      throw new Error(`Unexpected fixture request: ${href}`);
    };
    vi.stubGlobal("fetch", http);

    execute.mockImplementation(async (executable, args, { env }) => {
      expect(executable).toBe(
        fileURLToPath(
          new URL("../../node_modules/.bin/wrangler", import.meta.url),
        ),
      );
      expect(env).toMatchObject({
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "fixture-pages",
      });
      expect(Object.values(env)).not.toContain("fixture-source");
      expect(Object.values(env)).not.toContain("fixture-journal");
      expect(
        Object.keys(env).filter((key) => /GITHUB|JOURNAL|D1/u.test(key)),
      ).toEqual([]);
      const [command, action, directory] = args;
      if (command !== "pages" || action !== "deploy" || !directory)
        throw new Error("Unexpected Wrangler command");
      const fields = (flag: string) => args[args.indexOf(flag) + 1];
      expect(fields("--project-name")).toBe(project);
      expect(fields("--branch")).toBe("main");
      const id = deploymentId(deployments.size + 1);
      const files = new Map<string, Buffer>();
      for (const path of await readdir(directory, { recursive: true })) {
        if (path.includes("."))
          files.set("/" + path, await readFile(join(directory, path)));
      }
      deployments.set(id, {
        files,
        metadata: {
          id,
          project_id: projectId,
          uses_functions: false,
          project_name: project,
          environment: "production",
          deployment_trigger: {
            type: "ad_hoc",
            metadata: {
              branch: fields("--branch"),
              commit_hash: fields("--commit-hash"),
              commit_message: fields("--commit-message"),
              commit_dirty: false,
            },
          },
          is_skipped: false,
          latest_stage: {
            name: "deploy",
            status: "success",
            ended_on: "2026-11-24T00:00:00Z",
          },
        },
      });
      serving = id;
      if (id === deploymentId(1))
        throw new Error("Fixture lost the first upload acknowledgment");
      return true;
    });
    let observedGate: ReleaseCoordinatorGate | undefined;
    const coordinate: typeof coordinateRelease = (request, gate) => {
      observedGate = gate;
      return coordinateRelease(request, gate);
    };
    const options = { coordinate, sourceHttp: http };
    const environment = () => ({
      PORTFOLIO_PRODUCTION_ENABLED: "true",
      PORTFOLIO_PRODUCTION_ORIGIN: origin,
      PORTFOLIO_PRODUCTION_FIRST_CUTOVER: selected === first ? "true" : "false",
      PORTFOLIO_PRODUCTION_ACCOUNT_ID: accountId,
      PORTFOLIO_PRODUCTION_PROJECT: project,
      PORTFOLIO_PRODUCTION_DATABASE_ID: databaseId,
      PORTFOLIO_PRODUCTION_PYTHON: python,
      PORTFOLIO_PRODUCTION_ARTIFACT_TOKEN: "fixture-artifact",
      PORTFOLIO_PRODUCTION_PAGES_TOKEN: "fixture-pages",
      PORTFOLIO_PRODUCTION_JOURNAL_TOKEN: "fixture-journal",
      PORTFOLIO_RELEASE_SOURCE_TOKEN: "fixture-source",
      PORTFOLIO_RELEASE_NOTES_REF: "refs/heads/main",
      PORTFOLIO_RELEASE_NOTES_SENDER_ID: "42",
      PORTFOLIO_SELECTED_ORIGIN: origin,
      PORTFOLIO_SELECTED_SHA: selected.receipt.portfolioSha,
      PORTFOLIO_SELECTED_NOTES_SHA: selected.receipt.notesSha,
      PORTFOLIO_SELECTED_NOTES_RUN_ID: String(selected.notesRunId),
      PORTFOLIO_SELECTED_NOTES_RUN_ATTEMPT: String(notesRunAttempt),
      PORTFOLIO_SELECTED_RECEIPT: JSON.stringify(selected.receipt),
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: selected === first ? "push" : "repository_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_PROTECTED: "true",
      GITHUB_REPOSITORY: repository.full_name,
      GITHUB_SHA: selected.receipt.portfolioSha,
      GITHUB_WORKFLOW_REF: workflow("release"),
      GITHUB_WORKFLOW_SHA: selected.receipt.portfolioSha,
      GITHUB_RUN_ID: String(selected.receipt.runId),
      GITHUB_RUN_ATTEMPT: String(selected.receipt.runAttempt),
    });
    const publish = () =>
      runProductionRelease(
        environment(),
        selected === first
          ? {
              repository,
              after: first.receipt.portfolioSha,
              ref: "refs/heads/main",
              deleted: false,
            }
          : {
              repository,
              action: "portfolio-notes-verified",
              sender: { id: 42 },
              client_payload: {
                repository: notesRepository.full_name,
                ref: "refs/heads/main",
                sha: second.receipt.notesSha,
                runId: second.notesRunId,
              },
            },
        options,
      );
    const assertConfirmed = async (
      result: ReturnType<typeof publish>,
      operationId: number,
    ) =>
      expect(await result).toEqual({
        decision: "confirmed",
        operationId,
        exitCode: 0,
      });
    const assertActive = async (
      id: number,
      deployment: number,
      expected: typeof first,
    ) => {
      expect(await observedGate?.journal.readActive()).toMatchObject({
        id,
        state: "confirmed",
        deploymentId: deploymentId(deployment),
        receipt: expected.receipt,
      });
      const providerId = await observedGate?.pages.readServingDeploymentId();
      expect(providerId).toBe(deploymentId(deployment));
      const canonical = await http(new URL(releaseMarkerPath, origin));
      expect(Buffer.from(await canonical.arrayBuffer())).toEqual(
        expected.marker,
      );
      expect(await readdir(root)).toEqual([]);
    };

    await assertConfirmed(publish(), 1);
    await assertActive(1, 1, first);
    selected = second;
    expired = true;
    await assertConfirmed(publish(), 2);
    await assertActive(2, 2, second);
    const beforeDuplicate = history();
    expect(await publish()).toEqual({ decision: "noop", exitCode: 0 });
    expect(history()).toEqual(beforeDuplicate);
    const artifactIds = [first.receipt.artifactId, second.receipt.artifactId];
    expect(deployments.size).toBe(2);
    expect(downloaded).toEqual(artifactIds);
    const firstArtifact = await http(
      `${portfolioUrl}/actions/artifacts/${first.receipt.artifactId}`,
    );
    expect(await firstArtifact.json()).toMatchObject({ expired: true });
    const reference = "incident-123";
    await assertConfirmed(
      runProductionRelease(
        {
          ...environment(),
          PORTFOLIO_PRODUCTION_OPERATIONS_ENABLED: "true",
          PORTFOLIO_PRODUCTION_OPERATOR_ID: "42",
          GITHUB_ACTOR_ID: "42",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_WORKFLOW_REF: workflow("rollback"),
          GITHUB_RUN_ID: "90",
          GITHUB_RUN_ATTEMPT: "1",
        },
        {
          repository,
          ref: "main",
          sender: { id: 42 },
          inputs: {
            operation: "rollback",
            expected_active_id: "2",
            known_good_id: "1",
            reference,
          },
        },
        options,
      ),
      3,
    );
    await assertActive(3, 1, first);
    expect(rollbackIds).toEqual([deploymentId(1)]);
    expect(deployments.size).toBe(2);
    expect(downloaded).toEqual(artifactIds);
    const rows = history();
    const chain = rows.map(({ id, previousId, kind }) => [
      id,
      previousId,
      kind,
    ]);
    expect(chain).toEqual([
      [1, null, "release"],
      [2, 1, "release"],
      [3, 2, "rollback"],
    ]);
    expect(
      rows.slice(0, 2).map(({ proof }) => JSON.parse(String(proof))),
    ).toMatchObject([
      { runId: first.notesRunId, runAttempt: notesRunAttempt },
      { runId: second.notesRunId, runAttempt: notesRunAttempt },
    ]);
    expect(JSON.parse(String(rows[2]?.proof))).toEqual({
      knownGoodId: 1,
      reference,
    });
  } finally {
    execute.mockReset();
    vi.unstubAllGlobals();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
