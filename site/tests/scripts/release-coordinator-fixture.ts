import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  encodeReleaseMarker,
  releaseMarkerPath,
} from "../../scripts/release-build-marker.ts";
import type {
  ReleaseCoordinatorGate,
  ReleaseCoordinatorRequest,
} from "../../scripts/release-coordinator.ts";

const bytes = Buffer.from("fixture archive");
export const receipt = {
  portfolioSha: "1".repeat(40),
  notesSha: "2".repeat(40),
  snapshotSchema: 1,
  manifestSha256: "3".repeat(64),
  runId: 10,
  runAttempt: 1,
  artifactId: 100,
  archiveSha256: createHash("sha256").update(bytes).digest("hex"),
};
const prior = { ...receipt, portfolioSha: "4".repeat(40), runId: 8 };
const oldest = { ...receipt, portfolioSha: "5".repeat(40), runId: 7 };
const origin = "https://portfolio.example";
const portfolio = { id: 339077137, name: "angadsinghsandhu/angadsinghsandhu" };
const notes = { id: 590347468, name: "angadsinghsandhu/Notes" };
const notesProof = {
  repository: notes.name,
  repositoryId: notes.id,
  ref: "refs/heads/publish",
  sha: receipt.notesSha,
  workflowId: 100,
  runId: 50,
  runAttempt: 2,
  jobName: "verify",
  conclusion: "success" as const,
};
const approval = {
  portfolio: { repository: portfolio, ref: "refs/heads/main" },
  notes: {
    repository: notes,
    ref: notesProof.ref,
    workflowId: 100,
    jobName: "verify",
  },
};
export const releaseRequest = {
  kind: "release",
  verified: {
    receipt,
    notesCandidate: {
      repository: notes.name,
      ref: notesProof.ref,
      sha: receipt.notesSha,
      runId: 50,
    },
    notesRunAttempt: 2,
  },
} satisfies ReleaseCoordinatorRequest;
export const rollbackRequest = {
  kind: "rollback",
  expectedActiveId: 2,
  knownGoodId: 1,
  reference: "approval-1",
} satisfies ReleaseCoordinatorRequest;

const now = "2026-11-25T20:00:00.000Z";
const selectedId = "10000000-0000-0000-0000-000000000003";
const priorId = "10000000-0000-0000-0000-000000000002";
const oldestId = "10000000-0000-0000-0000-000000000001";
const retained = (id: number, deploymentId: string, value: typeof receipt) => ({
  id,
  previousId: id === 1 ? null : 1,
  kind: "release" as const,
  operationKey: deploymentId,
  notesProof,
  receipt: value,
  deploymentId,
  state: "confirmed" as const,
  createdAt: now,
  finishedAt: now,
});
type Journal = ReleaseCoordinatorGate["journal"];

export function fixture(first = false) {
  const history = new Map([
    [1, retained(1, oldestId, oldest)],
    [2, retained(2, priorId, prior)],
  ]);
  const state = {
    active: (first ? null : history.get(2)!) as Awaited<
      ReturnType<Journal["readActive"]>
    >,
    pending: null as Awaited<ReturnType<Journal["readPending"]>>,
    attempted: false,
    restoreEvidence: false,
    serving: first ? undefined : (priorId as string | undefined),
    canonical: first ? undefined : (prior as typeof receipt | undefined),
    head: receipt.portfolioSha,
    notesAttempt: notesProof.runAttempt,
    jobConclusion: "success",
    archive: bytes,
    badStageMarker: false,
    serveDeploy: true,
    deployResponseLost: false,
    beforeUpload: () => {},
    beforeRollback: () => {},
    observed: "confirmed" as "confirmed" | "failed" | "unknown",
    rollbackResponseLost: false,
    serveRollback: true,
    smokeSelected: true,
    unhealthyRunId: 0,
    confirmResponseLost: false,
    reserveResponseLost: false,
  };

  function marker(value: typeof receipt) {
    const { portfolioSha, notesSha, runId, runAttempt } = value;
    return encodeReleaseMarker({
      origin,
      portfolioSha,
      notesSha,
      runId,
      runAttempt,
    });
  }

  const repository = { id: notes.id, full_name: notes.name };
  const sourceHttp = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const check = {
      head_sha: receipt.notesSha,
      status: "completed",
      conclusion: "success",
    };
    if (path.endsWith("/" + portfolio.name))
      return Response.json({ id: portfolio.id, full_name: portfolio.name });
    if (path.endsWith("/" + notes.name)) return Response.json(repository);
    if (path.endsWith("/branches/main"))
      return Response.json({
        name: "main",
        protected: true,
        commit: { sha: state.head },
      });
    if (path.endsWith("/branches/publish"))
      return Response.json({
        name: "publish",
        protected: true,
        commit: { sha: receipt.notesSha },
      });
    if (path.endsWith("/actions/runs/50"))
      return Response.json({
        ...check,
        id: 50,
        run_attempt: state.notesAttempt,
        workflow_id: 100,
        repository,
        head_repository: repository,
        head_branch: "publish",
        event: "push",
      });
    if (path.endsWith("/jobs"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            ...check,
            conclusion: state.jobConclusion,
            name: "verify",
            run_id: 50,
            run_attempt: state.notesAttempt,
          },
        ],
      });
    return new Response(null, { status: 404 });
  });

  const artifactHttp = vi.fn<typeof fetch>(async () =>
    Response.json({
      id: 100,
      name: "portfolio-candidate-10-1",
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      digest: "sha256:" + receipt.archiveSha256,
      workflow_run: {
        id: 10,
        repository_id: portfolio.id,
        head_repository_id: portfolio.id,
        head_branch: "main",
        head_sha: receipt.portfolioSha,
      },
    }),
  );

  let queue = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const deploy = vi.fn<ReleaseCoordinatorGate["pages"]["deploy"]>(
    async (operation, _stage, beforeUpload) => {
      state.beforeUpload();
      if (beforeUpload && !(await beforeUpload()))
        return { status: "rejected" };
      state.attempted = true;
      if (state.serveDeploy) {
        state.serving = selectedId;
        state.canonical = receipt;
      }
      if (state.deployResponseLost) throw new Error("Pages response lost");
      expectOperationLink(operation);
      return { status: "submitted" };
    },
  );
  function expectOperationLink(operation: Parameters<typeof deploy>[0]) {
    if (state.pending?.operationKey !== operation.operationKey)
      throw new Error("hosting called without durable operation key");
  }
  const rollback = vi.fn<ReleaseCoordinatorGate["pages"]["rollback"]>(
    async ({ receipt: target }, id, expectedServingId) => {
      state.beforeRollback();
      if (
        expectedServingId !== undefined &&
        state.serving !== expectedServingId
      )
        return { status: "unknown" };
      if (state.serveRollback) {
        state.serving = id;
        state.canonical = target;
      }
      if (state.rollbackResponseLost || !state.serveRollback)
        return { status: "unknown" };
      return { status: "confirmed", deploymentId: id };
    },
  );
  const begin = vi.fn<Journal["begin"]>(async (input) => {
    if (state.pending || input.expectedActiveId !== (state.active?.id ?? null))
      throw new Error("fixture reservation conflict");
    const { firstCutover, expectedActiveId, ...request } = input;
    if (expectedActiveId === null && firstCutover !== true)
      throw new Error("fixture first cutover not approved");
    state.pending = {
      ...request,
      id: first ? 1 : 3,
      previousId: expectedActiveId,
      state: "pending",
      deploymentId: null,
      createdAt: now,
      finishedAt: null,
    };
    if (state.reserveResponseLost) throw new Error("D1 reserve response lost");
    return structuredClone(state.pending);
  });
  const confirm = vi.fn<Journal["confirmAfterProviderProof"]>(
    async (id, deploymentId) => {
      if (state.pending?.id !== id)
        throw new Error("fixture confirmation conflict");
      state.active = {
        ...state.pending,
        state: "confirmed",
        deploymentId,
        finishedAt: now,
      };
      state.pending = null;
      if (state.confirmResponseLost)
        throw new Error("D1 confirm response lost");
      return structuredClone(state.active);
    },
  );
  const abort = vi.fn<Journal["abortAfterProviderProof"]>(async (id) => {
    if (state.pending?.id !== id) throw new Error("fixture abort conflict");
    const aborted = {
      ...state.pending,
      state: "aborted" as const,
      finishedAt: now,
    };
    state.pending = null;
    return aborted;
  });
  const withStage = vi.fn<ReleaseCoordinatorGate["withStage"]>(
    async (selected, run) => {
      await artifactHttp("https://fixture.example/actions/artifacts/100");
      if (!state.archive.equals(bytes))
        throw new Error("Downloaded archive digest differs");
      const directory = await mkdtemp(
        join(await realpath(tmpdir()), "portfolio-coordinator-test-"),
      );
      try {
        await writeFile(
          join(directory, releaseMarkerPath),
          state.badStageMarker ? "wrong" : marker(selected),
        );
        return await run({ directory, executable: process.execPath });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  const gate = {
    approval,
    origin,
    serialized,
    withStage,
    firstCutover: first,
    automaticRestore: true,
    sourceApi: { token: "source-fixture", http: sourceHttp },
    journal: {
      readPending: async () => structuredClone(state.pending),
      readActive: async () => structuredClone(state.active),
      readKnownGood: async (id) => history.get(id) ?? null,
      begin,
      confirmAfterProviderProof: confirm,
      abortAfterProviderProof: abort,
    },
    pages: {
      deploy,
      rollback,
      readDeployment: async ({ receipt: value }, id) => {
        const found = [...history.values()].find(
          (item) =>
            item.deploymentId === id && item.receipt.runId === value.runId,
        );
        return found ||
          (state.attempted &&
            id === selectedId &&
            receipt.runId === value.runId)
          ? { status: "confirmed", deploymentId: id }
          : { status: "unknown" };
      },
      readServingDeploymentId: async () => state.serving,
      observe: async () => {
        if (state.observed === "confirmed" && state.attempted)
          return { status: "confirmed", deploymentId: selectedId };
        return {
          status:
            state.observed === "failed" && state.attempted
              ? "failed"
              : "unknown",
        };
      },
    },
    fetchMarker: async () =>
      state.canonical
        ? new Response(marker(state.canonical).toString("utf8"))
        : new Response(null, { status: 404 }),
    smoke: async (selected) =>
      selected.runId !== state.unhealthyRunId &&
      (selected.runId !== receipt.runId || state.smokeSelected),
    proveRestore: async () => state.restoreEvidence,
  } satisfies ReleaseCoordinatorGate;
  return {
    gate,
    state,
    history,
    begin,
    confirm,
    abort,
    deploy,
    rollback,
    withStage,
    artifactHttp,
    sourceHttp,
    serialized,
    priorId,
    oldestId,
    selectedId,
    prior,
  };
}
