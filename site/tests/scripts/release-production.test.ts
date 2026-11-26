import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { encodeReleaseMarker } from "../../scripts/release-build-marker.ts";
import type { coordinateRelease } from "../../scripts/release-coordinator.ts";
import {
  productionInput,
  runProductionRelease,
} from "../../scripts/release-production.ts";

const sha = "a".repeat(40);
const notes = "b".repeat(40);
const repository = {
  id: 339077137,
  full_name: "angadsinghsandhu/angadsinghsandhu",
  default_branch: "main",
};
const origin = "https://portfolio.example";
const workflow = (filename: string) =>
  `${repository.full_name}/.github/workflows/${filename}.yml@refs/heads/main`;
const receipt = {
  portfolioSha: sha,
  notesSha: notes,
  runId: 12,
  runAttempt: 2,
  artifactId: 123,
  archiveSha256: "c".repeat(64),
  snapshotSchema: 1,
  manifestSha256: "d".repeat(64),
};
const candidate = {
  PORTFOLIO_PRODUCTION_ENABLED: "true",
  PORTFOLIO_PRODUCTION_ORIGIN: origin,
  PORTFOLIO_SELECTED_ORIGIN: origin,
  PORTFOLIO_SELECTED_SHA: sha,
  PORTFOLIO_SELECTED_RECEIPT: JSON.stringify(receipt),
  PORTFOLIO_SELECTED_NOTES_SHA: notes,
  PORTFOLIO_SELECTED_NOTES_RUN_ID: "987",
  PORTFOLIO_SELECTED_NOTES_RUN_ATTEMPT: "3",
  PORTFOLIO_RELEASE_NOTES_REF: "refs/heads/main",
  PORTFOLIO_RELEASE_NOTES_SENDER_ID: "42",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_REPOSITORY: repository.full_name,
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_REF: workflow("portfolio-release"),
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_RUN_ID: "12",
  GITHUB_RUN_ATTEMPT: "2",
};
const event = {
  repository,
  after: sha,
  ref: candidate.GITHUB_REF,
  deleted: false,
};

it("binds the same-workflow receipt to the protected context and exact Notes attempt", () => {
  expect(productionInput(candidate, event)).toMatchObject({
    origin,
    request: {
      kind: "release",
      verified: {
        receipt,
        notesRunAttempt: 3,
        notesCandidate: { sha: notes, runId: 987, ref: "refs/heads/main" },
      },
    },
  });
});

it.each([
  ["PORTFOLIO_PRODUCTION_ENABLED", "TRUE"],
  ["GITHUB_ACTIONS", "false"],
  ["GITHUB_WORKFLOW_REF", workflow("portfolio-rollback")],
  ["GITHUB_REF_PROTECTED", "false"],
  ["GITHUB_WORKFLOW_SHA", notes],
  ["GITHUB_RUN_ID", "13"],
  ["GITHUB_RUN_ATTEMPT", "1"],
  ["PORTFOLIO_SELECTED_ORIGIN", "https://different.example"],
  ["PORTFOLIO_PRODUCTION_ORIGIN", origin + "/"],
  ["PORTFOLIO_SELECTED_SHA", notes],
  ["PORTFOLIO_SELECTED_NOTES_SHA", sha],
  ["PORTFOLIO_SELECTED_NOTES_RUN_ATTEMPT", "1\n"],
  ["PORTFOLIO_SELECTED_RECEIPT", JSON.stringify({ ...receipt, extra: 1 })],
])("rejects an invalid %s", (key, value) => {
  expect(() =>
    productionInput({ ...candidate, [key]: value }, event),
  ).toThrow();
});

it("checks the dispatch sender, run, and Notes ref against source selection", () => {
  const env = { ...candidate, GITHUB_EVENT_NAME: "repository_dispatch" };
  const dispatch = {
    repository,
    action: "portfolio-notes-verified",
    sender: { id: 42 },
    client_payload: {
      repository: "angadsinghsandhu/Notes",
      ref: candidate.PORTFOLIO_RELEASE_NOTES_REF,
      sha: notes,
      runId: 987,
    },
  };
  expect(productionInput(env, dispatch).request.kind).toBe("release");
  expect(() =>
    productionInput(env, { ...dispatch, sender: { id: 43 } }),
  ).toThrow();
  expect(() =>
    productionInput(env, {
      ...dispatch,
      client_payload: { ...dispatch.client_payload, runId: 988 },
    }),
  ).toThrow();
});

const operator = {
  ...candidate,
  PORTFOLIO_PRODUCTION_OPERATIONS_ENABLED: "true",
  PORTFOLIO_PRODUCTION_OPERATOR_ID: "42",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: workflow("portfolio-rollback"),
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR_ID: "42",
};
const manual = {
  repository,
  ref: "main",
  sender: { id: 42 },
  inputs: {
    operation: "rollback",
    expected_active_id: "8",
    known_good_id: "5",
    reference: "incident-123",
  },
};

it("requires the exact protected operator and first run attempt", () => {
  expect(productionInput(operator, manual).request).toEqual({
    kind: "rollback",
    expectedActiveId: 8,
    knownGoodId: 5,
    reference: "incident-123",
  });
  for (const env of [
    { ...operator, GITHUB_ACTOR_ID: "43" },
    { ...operator, GITHUB_RUN_ATTEMPT: "2" },
    { ...operator, PORTFOLIO_PRODUCTION_OPERATIONS_ENABLED: "True" },
    { ...operator, GITHUB_WORKFLOW_REF: workflow("portfolio-release") },
  ])
    expect(() => productionInput(env, manual)).toThrow();
  expect(() =>
    productionInput(operator, { ...manual, sender: { id: 43 } }),
  ).toThrow();
  expect(() =>
    productionInput(operator, {
      ...manual,
      inputs: { ...manual.inputs, reference: "case\n42" },
    }),
  ).toThrow();
  const recover = { ...manual, inputs: { operation: "recover" } };
  expect(productionInput(operator, recover).request).toEqual({
    kind: "recover",
  });
  expect(() =>
    productionInput(operator, {
      ...manual,
      inputs: { ...manual.inputs, operation: "recover" },
    }),
  ).toThrow();
});

const credentials = {
  PORTFOLIO_RELEASE_SOURCE_TOKEN: "fixture-source",
  PORTFOLIO_PRODUCTION_ARTIFACT_TOKEN: "fixture-artifact",
  PORTFOLIO_PRODUCTION_PAGES_TOKEN: "fixture-pages",
  PORTFOLIO_PRODUCTION_JOURNAL_TOKEN: "fixture-journal",
  PORTFOLIO_PRODUCTION_ACCOUNT_ID: "e".repeat(32),
  PORTFOLIO_PRODUCTION_PROJECT: "fixture",
  PORTFOLIO_PRODUCTION_DATABASE_ID: "12345678-abcd-abcd-abcd-123456789abc",
  PORTFOLIO_PRODUCTION_PYTHON: "/fixture/python",
  RUNNER_TEMP: "/fixture",
  PORTFOLIO_PRODUCTION_FIRST_CUTOVER: "True",
};

function protectedHead(head = sha, defaultBranch = "main") {
  return vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/branches/main")
      ? Response.json({ name: "main", protected: true, commit: { sha: head } })
      : Response.json({ ...repository, default_branch: defaultBranch }),
  );
}

it("feeds the verified receipt into the coordinator and distinguishes recovered work", async () => {
  const coordinate = vi
    .fn()
    .mockResolvedValue({ decision: "recovered", operationId: 5 });
  const env = { ...candidate, ...credentials };
  const sourceHttp = protectedHead();
  const result = await runProductionRelease(env, event, {
    coordinate,
    sourceHttp,
  });
  expect(result).toEqual({
    decision: "recovered",
    operationId: 5,
    exitCode: 1,
  });
  expect(coordinate).toHaveBeenCalledWith(
    productionInput(candidate, event).request,
    expect.objectContaining({
      firstCutover: false,
      sourceApi: { token: "fixture-source", http: sourceHttp },
    }),
  );
  expect(coordinate.mock.calls[0]?.[1]).not.toHaveProperty("proveRestore");
  expect(coordinate.mock.calls[0]?.[1]).not.toHaveProperty(
    "proveFirstCutoverFailure",
  );
  expect(sourceHttp).toHaveBeenCalledTimes(3);
});

it.each([
  ["a stale workflow head", notes, "main"],
  ["a different current default branch", sha, "other"],
])(
  "refuses %s before calling the coordinator",
  async (_case, head, defaultBranch) => {
    const coordinate = vi.fn();
    const sourceHttp = protectedHead(head, defaultBranch);
    await expect(
      runProductionRelease(
        {
          ...operator,
          PORTFOLIO_RELEASE_SOURCE_TOKEN: "fixture-source",
        },
        manual,
        { coordinate, sourceHttp },
      ),
    ).rejects.toThrow(/protected default head/);
    expect(coordinate).not.toHaveBeenCalled();
  },
);

it("executes the local CLI's credential-free preflight and suppresses invalid payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-preflight-"));
  try {
    const path = join(root, "event.json");
    await writeFile(path, JSON.stringify(event));
    const script = fileURLToPath(
      new URL("../../scripts/release-production.ts", import.meta.url),
    );
    const run = (flag: string) =>
      spawnSync(process.execPath, [script, "--check"], {
        env: {
          ...candidate,
          GITHUB_EVENT_PATH: path,
          PORTFOLIO_PRODUCTION_ENABLED: flag,
        },
        encoding: "utf8",
        timeout: 5_000,
      });
    expect(run("true")).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(run("True")).toMatchObject({
      status: 1,
      stdout: "",
      stderr: "Production release could not be verified or completed\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stages the exact verified receipt through the disk adapter and cleans scratch after a callback failure", async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "production-stage-"),
  );
  try {
    const python = execFileSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    ).trim();
    const marker = encodeReleaseMarker({
      origin,
      portfolioSha: receipt.portfolioSha,
      notesSha: receipt.notesSha,
      runId: receipt.runId,
      runAttempt: receipt.runAttempt,
    });
    const archive = execFileSync(
      python,
      [
        "-c",
        `
import sys, zipfile
with zipfile.ZipFile(sys.stdout.buffer, "w") as output:
    output.writestr("portfolio-release.json", sys.argv[1])
    output.writestr("index.html", "fixture index")
`,
        marker.toString("utf8"),
      ],
      { timeout: 10_000 },
    );
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const selectedReceipt = { ...receipt, archiveSha256 };
    const signedUrl = "https://fixture.example/verified.zip?sig=fixture";
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: receipt.artifactId,
          name: "portfolio-candidate-12-2",
          expired: false,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          digest: "sha256:" + archiveSha256,
          workflow_run: {
            id: receipt.runId,
            repository_id: repository.id,
            head_repository_id: repository.id,
            head_branch: "main",
            head_sha: sha,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: signedUrl } }),
      )
      .mockResolvedValueOnce(new Response(Uint8Array.from(archive)));
    vi.stubGlobal("fetch", http);
    await writeFile(join(root, "unrelated"), "keep");
    const failure = new Error("simulated interruption");
    const coordinate: typeof coordinateRelease = async (request, gate) => {
      if (request.kind !== "release") throw new Error("Expected a release");
      expect(request.verified.receipt).toEqual(selectedReceipt);
      return gate.withStage(
        request.verified.receipt,
        async ({ directory, executable }) => {
          expect(dirname(dirname(directory))).toBe(root);
          expect(executable).toMatch(/\/node_modules\/\.bin\/wrangler$/u);
          expect(await readFile(join(directory, "index.html"), "utf8")).toBe(
            "fixture index",
          );
          throw failure;
        },
      );
    };
    await expect(
      runProductionRelease(
        {
          ...candidate,
          ...credentials,
          PORTFOLIO_SELECTED_RECEIPT: JSON.stringify(selectedReceipt),
          PORTFOLIO_PRODUCTION_PYTHON: python,
          RUNNER_TEMP: root,
        },
        event,
        { coordinate, sourceHttp: protectedHead() },
      ),
    ).rejects.toBe(failure);
    expect(await readdir(root)).toEqual(["unrelated"]);
    expect(
      new Headers(http.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer fixture-artifact");
    expect(
      new Headers(http.mock.calls[2]?.[1]?.headers).has("authorization"),
    ).toBe(false);
    expect(String(http.mock.calls[2]?.[0])).toBe(signedUrl);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});
