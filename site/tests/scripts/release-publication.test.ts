import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { ReleaseReceipt } from "../../scripts/release-policy.ts";
import { publishRelease } from "../../scripts/release-publication.ts";

const earlierArchive = Buffer.from(
  "UEsDBBQAAAAAAAAAIQCLntnTAQAAAAEAAAAKAAAAaW5kZXguaHRtbEFQSwECFAMUAAAAAAAAACEAi57Z0wEAAAABAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAApAAAAAAA=",
  "base64",
);
const currentArchive = Buffer.from(
  "UEsDBBQAAAAAAAAAIQAxz9BKAQAAAAEAAAAKAAAAaW5kZXguaHRtbEJQSwECFAMUAAAAAAAAACEAMc/QSgEAAAABAAAACgAAAAAAAAAAAAAAgAEAAAAAaW5kZXguaHRtbFBLBQYAAAAAAQABADgAAAApAAAAAAA=",
  "base64",
);
const earlier = {
  portfolioSha: "1".repeat(40),
  notesSha: "2".repeat(40),
  snapshotSchema: 1,
  manifestSha256: "3".repeat(64),
  runId: 10,
  runAttempt: 1,
  artifactId: 100,
  archiveSha256:
    "a51d27f838e810354555e6127268e74a275eb3dc3805678a3ae1f297f0c8fe3d",
};
const current = {
  portfolioSha: "4".repeat(40),
  notesSha: "5".repeat(40),
  snapshotSchema: 1,
  manifestSha256: "6".repeat(64),
  runId: 20,
  runAttempt: 1,
  artifactId: 200,
  archiveSha256:
    "8ea4a366393080afc16379e22aa33f205734f455fafe079bd0bca95e349a6f8f",
};
const retry = { ...current, runAttempt: 2, artifactId: 201 };
const approval = {
  portfolio: {
    repository: { id: 339077137, name: "angadsinghsandhu/angadsinghsandhu" },
    ref: "refs/heads/main",
  },
  notes: {
    repository: { id: 590347468, name: "angadsinghsandhu/Notes" },
    ref: "refs/heads/publish",
    workflowId: 379127533,
    jobName: "verify",
  },
};
const github = "https://api.github.com/repos/";
const portfolioPath = github + approval.portfolio.repository.name;
const notesPath = github + approval.notes.repository.name;
const notesRunId = 900;
const notesRunAttempt = 4;

function fixture(active: ReleaseReceipt | null = null, retained = earlier) {
  const state = {
    active,
    activatedArchive: active
      ? active.artifactId === earlier.artifactId
        ? earlierArchive
        : currentArchive
      : null,
    heads: { portfolioSha: current.portfolioSha, notesSha: current.notesSha },
    authorizedRollback: undefined as ReleaseReceipt | undefined,
    notesRun: {
      attempt: notesRunAttempt,
      status: "completed",
      conclusion: "success" as string | null,
    },
  };
  const artifacts = new Map([
    [retained.artifactId, retained],
    [current.artifactId, current],
    [retry.artifactId, retry],
  ]);
  const archives = new Map([
    [earlier.artifactId, earlierArchive],
    [current.artifactId, currentArchive],
    [retry.artifactId, currentArchive],
  ]);
  let queued = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queued.then(operation);
    queued = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const notesRepository = {
    id: approval.notes.repository.id,
    full_name: approval.notes.repository.name,
  };
  const sourceHttp = vi.fn<typeof fetch>(async (url) => {
    const notesCheck = {
      head_sha: state.heads.notesSha,
      status: state.notesRun.status,
      conclusion: state.notesRun.conclusion,
    };
    switch (url) {
      case portfolioPath:
        return Response.json({
          id: approval.portfolio.repository.id,
          full_name: approval.portfolio.repository.name,
        });
      case portfolioPath + "/branches/main":
        return Response.json({
          name: "main",
          protected: true,
          commit: { sha: state.heads.portfolioSha },
        });
      case notesPath:
        return Response.json(notesRepository);
      case notesPath + "/branches/publish":
        return Response.json({
          name: "publish",
          protected: true,
          commit: { sha: state.heads.notesSha },
        });
      case notesPath + "/actions/runs/900":
        return Response.json({
          ...notesCheck,
          id: notesRunId,
          run_attempt: state.notesRun.attempt,
          workflow_id: approval.notes.workflowId,
          repository: notesRepository,
          head_repository: notesRepository,
          head_branch: "publish",
          event: "push",
        });
      case notesPath +
        `/actions/runs/900/attempts/${state.notesRun.attempt}/jobs?per_page=100`:
        return Response.json({
          total_count: 1,
          jobs: [
            {
              ...notesCheck,
              name: "verify",
              run_id: notesRunId,
              run_attempt: state.notesRun.attempt,
            },
          ],
        });
      default:
        return new Response(null, { status: 404 });
    }
  });

  const artifactHttp = vi.fn<typeof fetch>(async (url) => {
    const prefix = portfolioPath + "/actions/artifacts/";
    if (typeof url !== "string" || !url.startsWith(prefix))
      return new Response(null, { status: 404 });
    const artifact = artifacts.get(Number(url.slice(prefix.length)));
    if (!artifact) return new Response(null, { status: 404 });
    return Response.json({
      id: artifact.artifactId,
      name: `portfolio-candidate-${artifact.runId}-${artifact.runAttempt}`,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      digest: "sha256:" + artifact.archiveSha256,
      workflow_run: {
        id: artifact.runId,
        repository_id: approval.portfolio.repository.id,
        head_repository_id: approval.portfolio.repository.id,
        head_branch: "main",
        head_sha: artifact.portfolioSha,
      },
    });
  });
  const readArchive = vi.fn(async (artifactId: number) => {
    const bytes = archives.get(artifactId);
    if (!bytes) throw new Error("Fixture archive is unavailable");
    return bytes;
  });
  const activate = vi.fn(async (receipt: ReleaseReceipt, bytes: Uint8Array) => {
    state.active = structuredClone(receipt);
    state.activatedArchive = Buffer.from(bytes);
  });
  const readActive = vi.fn(async () => structuredClone(state.active));

  return {
    state,
    dependencies: () => ({
      approval,
      serialized,
      sourceApi: { token: "fixture-source-token", http: sourceHttp },
      artifact: {
        api: { token: "fixture-artifact-token", http: artifactHttp },
        readArchive,
      },
      readActive,
      readVerified: async (requested: ReleaseReceipt) => {
        const receipt = artifacts.get(requested.artifactId);
        if (!receipt) return undefined;
        return {
          receipt: structuredClone(receipt),
          notesRunAttempt,
          notesCandidate: {
            repository: approval.notes.repository.name,
            ref: approval.notes.ref,
            sha: receipt.notesSha,
            runId: notesRunId,
          },
        };
      },
      readAuthorizedRollback: async () =>
        structuredClone(state.authorizedRollback),
      activate,
    }),
    serialized,
    sourceHttp,
    artifactHttp,
    readArchive,
    readActive,
    activate,
  };
}

it.each(["portfolioSha", "notesSha"] as const)(
  "rereads %s inside the shared gate and rejects the superseded queued pair",
  async (updatedSource) => {
    const stale = {
      ...earlier,
      portfolioSha: current.portfolioSha,
      notesSha: current.notesSha,
      [updatedSource]: earlier[updatedSource],
    };
    const rehearsal = fixture(null, stale);
    rehearsal.state.heads[updatedSource] = stale[updatedSource];
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const blocker = rehearsal.serialized(async () => {
      entered.resolve();
      await unblock.promise;
    });
    await entered.promise;
    const outcomes = Promise.allSettled([
      publishRelease(
        { kind: "release", receipt: stale },
        rehearsal.dependencies(),
      ),
      publishRelease(
        { kind: "release", receipt: current },
        rehearsal.dependencies(),
      ),
    ]);
    await setImmediate();
    const earlySourceReads = rehearsal.sourceHttp.mock.calls.length;
    const earlyActiveReads = rehearsal.readActive.mock.calls.length;
    rehearsal.state.heads[updatedSource] = current[updatedSource];
    unblock.resolve();

    await blocker;
    const [first, second] = await outcomes;
    expect(first).toMatchObject({
      status: "fulfilled",
      value: {
        decision: "deny",
        reason: expect.stringContaining("current protected head"),
      },
    });
    expect(second).toEqual({
      status: "fulfilled",
      value: { decision: "publish" },
    });
    expect(earlySourceReads).toBe(0);
    expect(earlyActiveReads).toBe(0);
    expect(rehearsal.readArchive.mock.calls).toEqual([[current.artifactId]]);
    expect(rehearsal.state.active).toEqual(current);
    expect(rehearsal.state.activatedArchive).toEqual(currentArchive);
  },
);

it("skips the active pair across independent calls sharing durable state even with a different artifact", async () => {
  const rehearsal = fixture();
  await expect(
    publishRelease(
      { kind: "release", receipt: current },
      rehearsal.dependencies(),
    ),
  ).resolves.toEqual({ decision: "publish" });
  await expect(
    publishRelease(
      { kind: "release", receipt: retry },
      rehearsal.dependencies(),
    ),
  ).resolves.toEqual({ decision: "noop" });
  expect(rehearsal.readActive).toHaveBeenCalledTimes(2);
  expect(rehearsal.artifactHttp).toHaveBeenCalledTimes(1);
  expect(rehearsal.activate).toHaveBeenCalledTimes(1);
  expect(rehearsal.state.active).toEqual(current);
});

it("rejects requests without a matching trusted candidate receipt", async () => {
  const rehearsal = fixture();
  const forged = { ...current, manifestSha256: earlier.manifestSha256 };
  await expect(
    publishRelease(
      { kind: "release", receipt: forged },
      rehearsal.dependencies(),
    ),
  ).resolves.toMatchObject({ decision: "deny" });
  expect(rehearsal.artifactHttp).not.toHaveBeenCalled();
  expect(rehearsal.state.active).toBeNull();
});

it("denies rollback without explicit authorization for the exact retained receipt", async () => {
  const rehearsal = fixture(current);
  const rollback = { kind: "rollback", receipt: earlier } as const;
  await expect(
    publishRelease(rollback, rehearsal.dependencies()),
  ).resolves.toMatchObject({ decision: "deny" });

  rehearsal.state.authorizedRollback = { ...earlier, artifactId: 999 };
  await expect(
    publishRelease(rollback, rehearsal.dependencies()),
  ).resolves.toMatchObject({ decision: "deny" });
  expect(rehearsal.artifactHttp).not.toHaveBeenCalled();
  expect(rehearsal.state.active).toEqual(current);
});

it("restores only the entitled artifact for an older pair and skips an identical retry", async () => {
  const rehearsal = fixture(current);
  rehearsal.state.authorizedRollback = earlier;
  const rollback = { kind: "rollback", receipt: earlier } as const;
  await expect(
    publishRelease(rollback, rehearsal.dependencies()),
  ).resolves.toEqual({ decision: "publish" });
  await expect(
    publishRelease(rollback, rehearsal.dependencies()),
  ).resolves.toEqual({ decision: "noop" });
  expect(rehearsal.sourceHttp).not.toHaveBeenCalled();
  expect(rehearsal.readArchive).toHaveBeenCalledExactlyOnceWith(100);
  expect(rehearsal.state.active).toEqual(earlier);
  expect(rehearsal.state.activatedArchive).toEqual(earlierArchive);
});

it.each(["unavailable", "substituted"])(
  "preserves the active release when the authorized rollback archive is %s",
  async (failure) => {
    const rehearsal = fixture(current);
    rehearsal.state.authorizedRollback = earlier;
    if (failure === "unavailable")
      rehearsal.readArchive.mockRejectedValue(
        new Error("Fixture archive is unavailable"),
      );
    else rehearsal.readArchive.mockResolvedValue(currentArchive);

    await expect(
      publishRelease(
        { kind: "rollback", receipt: earlier },
        rehearsal.dependencies(),
      ),
    ).rejects.toThrow(/archive/u);
    expect(rehearsal.activate).not.toHaveBeenCalled();
    expect(rehearsal.state.active).toEqual(current);
    expect(rehearsal.state.activatedArchive).toEqual(currentArchive);
  },
);

it.each(["portfolioSha", "notesSha"] as const)(
  "preserves the active release when %s changes during archive retrieval",
  async (updatedSource) => {
    const rehearsal = fixture(earlier);
    rehearsal.readArchive.mockImplementationOnce(async () => {
      rehearsal.state.heads[updatedSource] = earlier[updatedSource];
      return currentArchive;
    });
    await expect(
      publishRelease(
        { kind: "release", receipt: current },
        rehearsal.dependencies(),
      ),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("current protected head"),
    });
    expect(rehearsal.readArchive).toHaveBeenCalledExactlyOnceWith(200);
    expect(rehearsal.activate).not.toHaveBeenCalled();
    expect(rehearsal.state.active).toEqual(earlier);
    expect(rehearsal.state.activatedArchive).toEqual(earlierArchive);
  },
);

it("denies a newer successful Notes attempt before fetching the artifact", async () => {
  const rehearsal = fixture(earlier);
  rehearsal.state.notesRun.attempt++;

  await expect(
    publishRelease(
      { kind: "release", receipt: current },
      rehearsal.dependencies(),
    ),
  ).resolves.toMatchObject({
    decision: "deny",
    reason: expect.stringContaining("Notes verification run"),
  });
  expect(rehearsal.artifactHttp).not.toHaveBeenCalled();
  expect(rehearsal.readArchive).not.toHaveBeenCalled();
  expect(rehearsal.activate).not.toHaveBeenCalled();
  expect(rehearsal.state.active).toEqual(earlier);
});

it.each(["completed", "in_progress"])(
  "denies a newer %s Notes attempt before activation after retrieving the archive",
  async (status) => {
    const rehearsal = fixture(earlier);
    rehearsal.readArchive.mockImplementationOnce(async () => {
      rehearsal.state.notesRun = {
        attempt: notesRunAttempt + 1,
        status,
        conclusion: status === "completed" ? "success" : null,
      };
      return currentArchive;
    });

    await expect(
      publishRelease(
        { kind: "release", receipt: current },
        rehearsal.dependencies(),
      ),
    ).resolves.toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("Notes verification run"),
    });
    expect(rehearsal.readArchive).toHaveBeenCalledExactlyOnceWith(200);
    expect(rehearsal.activate).not.toHaveBeenCalled();
    expect(rehearsal.state.active).toEqual(earlier);
    expect(rehearsal.state.activatedArchive).toEqual(earlierArchive);
  },
);
