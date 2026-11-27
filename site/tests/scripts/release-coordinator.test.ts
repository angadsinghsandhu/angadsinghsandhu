import { expect, it, vi } from "vitest";
import {
  coordinateRelease,
  type ReleaseCoordinatorGate,
} from "../../scripts/release-coordinator.ts";
import {
  fixture,
  releaseRequest,
  rollbackRequest,
} from "./release-coordinator-fixture.ts";

const recover = { kind: "recover" } as const;

it("serializes concurrent candidates and only stages the still-current protected pair", async () => {
  const f = fixture();
  const old = {
    ...releaseRequest,
    verified: { ...releaseRequest.verified, receipt: f.prior },
  };
  const lock = Promise.withResolvers<void>();
  const blocker = f.serialized(() => lock.promise);
  f.state.head = f.prior.portfolioSha;
  const queued = Promise.all([
    coordinateRelease(old, f.gate),
    coordinateRelease(releaseRequest, f.gate),
  ]);
  expect(f.sourceHttp).not.toHaveBeenCalled();
  f.state.head = releaseRequest.verified.receipt.portfolioSha;
  lock.resolve();
  await blocker;
  await expect(queued).resolves.toMatchObject([
    { decision: "deny" },
    { decision: "confirmed" },
  ]);
  expect(f.deploy).toHaveBeenCalledTimes(1);
});

it.each(["portfolio head", "Notes attempt", "Notes job"])(
  "aborts before upload when the %s changes during provider preparation",
  async (failure) => {
    const f = fixture();
    f.state.beforeUpload = () => {
      if (failure === "portfolio head") f.state.head = f.prior.portfolioSha;
      if (failure === "Notes attempt") f.state.notesAttempt++;
      if (failure === "Notes job") f.state.jobConclusion = "failure";
    };
    await expect(
      coordinateRelease(releaseRequest, f.gate),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(f.abort).toHaveBeenCalledExactlyOnceWith(3);
    expect(f.state.attempted).toBe(false);
  },
);

it("deduplicates only after deployment identity and canonical health prove the active pair", async () => {
  const f = fixture();
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "confirmed" });
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "noop" });
  f.state.serving = f.priorId;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "deny" });
  expect(f.deploy).toHaveBeenCalledTimes(1);
});

it("denies first cutover without explicit approval", async () => {
  const f = fixture(true);
  await expect(
    coordinateRelease(releaseRequest, { ...f.gate, firstCutover: false }),
  ).resolves.toMatchObject({ decision: "deny" });
  expect(f.begin).not.toHaveBeenCalled();
});

it("keeps a failed first cutover pending without independent absence evidence", async () => {
  const f = fixture(true);
  f.state.serveDeploy = false;
  f.state.observed = "failed";
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  await expect(coordinateRelease(recover, f.gate)).resolves.toMatchObject({
    decision: "pending",
  });
  await expect(
    coordinateRelease(recover, {
      ...f.gate,
      proveFirstCutoverFailure: async () => true,
    }),
  ).resolves.toMatchObject({ decision: "recovered" });
  expect(f.abort).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.deploy).toHaveBeenCalledTimes(1);
});

it("rejects a corrupt archive before reserving", async () => {
  const f = fixture();
  f.state.archive = Buffer.from("corrupt");
  await expect(coordinateRelease(releaseRequest, f.gate)).rejects.toThrow(
    /archive digest/u,
  );
  expect(f.deploy).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});

it("rejects a mismatched staged marker before reserving", async () => {
  const f = fixture();
  f.state.badStageMarker = true;
  await expect(coordinateRelease(releaseRequest, f.gate)).rejects.toThrow(
    /marker differs/u,
  );
  expect(f.begin).not.toHaveBeenCalled();
});

it("confirms a unique deployed operation even if the provider response is lost", async () => {
  const f = fixture();
  f.state.deployResponseLost = true;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "confirmed", operationId: 3 });
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith(3, f.selectedId);
});

it("keeps a lost D1 reservation pending and never retries an unobserved hosting change", async () => {
  const f = fixture();
  f.state.reserveResponseLost = true;
  await expect(coordinateRelease(releaseRequest, f.gate)).rejects.toThrow(
    "D1 reserve response lost",
  );
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  expect(f.deploy).not.toHaveBeenCalled();
  expect(f.abort).not.toHaveBeenCalled();
});

it("does not restore or abort on canonical mismatch after a successful deployment", async () => {
  const f = fixture();
  f.state.serveDeploy = false;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  await expect(coordinateRelease(recover, f.gate)).resolves.toMatchObject({
    decision: "pending",
  });
  expect(f.rollback).not.toHaveBeenCalled();
  expect(f.abort).not.toHaveBeenCalled();
  f.state.canonical = releaseRequest.verified.receipt;
  f.state.serving = f.selectedId;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "recovered", operationId: 3 });
  expect(f.deploy).toHaveBeenCalledTimes(1);
});

it("restores the exact previous deployment on selected marker and failed smoke", async () => {
  const f = fixture();
  f.state.smokeSelected = false;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "recovered" });
  expect(f.rollback).toHaveBeenCalledExactlyOnceWith(
    { receipt: f.prior },
    f.priorId,
    f.selectedId,
  );
  expect(f.state.active?.deploymentId).toBe(f.priorId);
  expect(f.state.serving).toBe(f.priorId);
  expect(f.abort).toHaveBeenCalledExactlyOnceWith(3);
});

it("keeps failed automatic restoration pending and reconciles only terminal restore evidence", async () => {
  const f = fixture();
  f.state.smokeSelected = false;
  f.state.serveRollback = false;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  f.state.serving = f.priorId;
  f.state.canonical = f.prior;
  await expect(coordinateRelease(recover, f.gate)).resolves.toMatchObject({
    decision: "pending",
  });
  f.state.restoreEvidence = true;
  await expect(coordinateRelease(recover, f.gate)).resolves.toMatchObject({
    decision: "recovered",
  });
  expect(f.rollback).toHaveBeenCalledTimes(1);
  expect(f.abort).toHaveBeenCalledExactlyOnceWith(3);
});

it("rolls back after artifact expiry by exact retained provider identity", async () => {
  const f = fixture();
  f.artifactHttp.mockResolvedValue(new Response(null, { status: 410 }));
  await expect(
    coordinateRelease(rollbackRequest, f.gate),
  ).resolves.toMatchObject({ decision: "confirmed", operationId: 3 });
  expect(f.rollback).toHaveBeenCalledExactlyOnceWith(
    { receipt: f.history.get(1)!.receipt },
    f.oldestId,
    f.priorId,
  );
  expect(f.artifactHttp).not.toHaveBeenCalled();
  expect(f.state.active?.deploymentId).toBe(f.oldestId);
});

it("ends an explicit rollback replay as recovery without repeating the mutation", async () => {
  const f = fixture();
  f.state.serveRollback = false;
  await expect(
    coordinateRelease(rollbackRequest, f.gate),
  ).resolves.toMatchObject({ decision: "pending" });
  f.state.serving = f.oldestId;
  f.state.canonical = f.history.get(1)!.receipt;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "recovered" });
  expect(f.rollback).toHaveBeenCalledTimes(1);
  expect(f.deploy).not.toHaveBeenCalled();
  expect(f.state.active?.deploymentId).toBe(f.oldestId);
});

it("propagates a lost D1 confirmation response and rereads the committed active row", async () => {
  const f = fixture();
  f.state.confirmResponseLost = true;
  await expect(coordinateRelease(releaseRequest, f.gate)).rejects.toThrow(
    "D1 confirm response lost",
  );
  expect(f.rollback).not.toHaveBeenCalled();
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({ decision: "noop" });
  expect(f.deploy).toHaveBeenCalledTimes(1);
});

it("allows exact approved rollback while a route on the identified active release is unhealthy", async () => {
  const f = fixture();
  f.state.unhealthyRunId = f.prior.runId;
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({
    decision: "deny",
  });
  await expect(
    coordinateRelease(rollbackRequest, f.gate),
  ).resolves.toMatchObject({
    decision: "confirmed",
  });
  expect(f.state.active?.deploymentId).toBe(f.oldestId);
});

it("does not automatically restore if serving deployment changes while locating the retained target", async () => {
  const f = fixture();
  f.state.smokeSelected = false;
  const lookup = f.gate.pages.readDeployment;
  f.gate.pages.readDeployment = async (request, deploymentId) => {
    if (f.state.attempted && deploymentId === f.priorId)
      f.state.serving = f.oldestId;
    return lookup(request, deploymentId);
  };
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({
    decision: "pending",
  });
  expect(f.rollback).not.toHaveBeenCalled();
});

it.each(["automatic restore", "explicit rollback"] as const)(
  "keeps %s pending if Pages finds a different live deployment during its preflight",
  async (kind) => {
    const f = fixture();
    f.state.smokeSelected = false;
    f.state.beforeRollback = () => {
      f.state.serving = "10000000-0000-0000-0000-000000000009";
    };
    await expect(
      coordinateRelease(
        kind === "automatic restore" ? releaseRequest : rollbackRequest,
        f.gate,
      ),
    ).resolves.toMatchObject({ decision: "pending" });
    expect(f.state.serving).toBe("10000000-0000-0000-0000-000000000009");
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  },
);

it("deploys the verified directory and executable even if staging later changes its descriptor", async () => {
  const f = fixture();
  const stageArchive = f.withStage.getMockImplementation()!;
  let verifiedStage: Parameters<typeof f.deploy>[1] | undefined;
  f.withStage.mockImplementationOnce((selected, run) =>
    stageArchive(selected, async (stage) => {
      verifiedStage = { ...stage };
      const original = f.begin.getMockImplementation()!;
      f.begin.mockImplementationOnce(async (input) => {
        stage.directory = "/substituted-output";
        stage.executable = "/substituted-executable";
        return original(input);
      });
      return run(stage);
    }),
  );
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({
    decision: "confirmed",
  });
  expect(f.deploy.mock.calls[0][1]).toEqual(verifiedStage);
});

it.each(["unknown", "thrown", "unexplained rejection"] as const)(
  "keeps a reservation pending after an %s preflight result",
  async (result) => {
    const f = fixture();
    let uploadAllowed: boolean | undefined;
    f.deploy.mockImplementationOnce(async (_request, _stage, beforeUpload) => {
      if (result === "unexplained rejection") return { status: "rejected" };
      f.state.notesAttempt++;
      uploadAllowed = await beforeUpload?.();
      if (result === "thrown") throw new Error("preflight transport lost");
      return { status: "unknown" };
    });
    await expect(
      coordinateRelease(releaseRequest, f.gate),
    ).resolves.toMatchObject({
      decision: "pending",
    });
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.state.pending?.id).toBe(3);
    if (result !== "unexplained rejection") expect(uploadAllowed).toBe(false);
  },
);

it("aborts before upload if the prior serving deployment changed during preparation", async () => {
  const f = fixture();
  let readsBeforePreflight = 0;
  f.state.beforeUpload = () => {
    readsBeforePreflight = f.sourceHttp.mock.calls.length;
    f.state.serving = f.oldestId;
  };
  await expect(
    coordinateRelease(releaseRequest, f.gate),
  ).resolves.toMatchObject({
    decision: "deny",
  });
  expect(f.state.attempted).toBe(false);
  expect(f.abort).toHaveBeenCalledExactlyOnceWith(3);
  expect(f.sourceHttp.mock.calls).toHaveLength(readsBeforePreflight);
});

const practice = {
  pagesSha256: "1".repeat(64),
  workerSha256: "2".repeat(64),
  workerFiles: 14,
};
const paired = {
  ...releaseRequest,
  verified: {
    ...releaseRequest.verified,
    receipt: { ...releaseRequest.verified.receipt, practice },
  },
};
function pairedGate(
  f: ReturnType<typeof fixture>,
  ensure: NonNullable<ReleaseCoordinatorGate["practice"]>["ensure"],
) {
  return {
    ...f.gate,
    practice: { ensure, probe: async () => true },
    withStage: (
      receipt: Parameters<typeof f.gate.withStage>[0],
      callback: Parameters<typeof f.gate.withStage>[1],
    ) =>
      f.gate.withStage(receipt, (stage) =>
        callback({ ...stage, workerDirectory: "/fixture/worker-assets" }),
      ),
  };
}
it("publishes and probes trace packages before reserving the Pages deployment", async () => {
  const f = fixture();
  const ensure = vi
    .fn<NonNullable<ReleaseCoordinatorGate["practice"]>["ensure"]>()
    .mockImplementation(async (worker, proof, _executable, eligible) => {
      expect(worker).toBe("/fixture/worker-assets");
      expect(proof).toEqual(practice);
      expect(f.begin).not.toHaveBeenCalled();
      return eligible();
    });
  await expect(
    coordinateRelease(paired, pairedGate(f, ensure)),
  ).resolves.toMatchObject({ decision: "confirmed" });
  expect(ensure).toHaveBeenCalledOnce();
  expect(f.deploy).toHaveBeenCalledOnce();
});
it("leaves Pages and its journal alone after an unproved Worker activation", async () => {
  const f = fixture();
  const gate = pairedGate(f, async () => false);
  await expect(coordinateRelease(paired, gate)).resolves.toMatchObject({
    decision: "deny",
  });
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.deploy).not.toHaveBeenCalled();
});
it("requires retained packages before rolling back to a paired Pages deployment", async () => {
  const f = fixture();
  f.history.get(1)!.receipt = { ...f.history.get(1)!.receipt, practice };
  const gate = {
    ...f.gate,
    practice: { ensure: async () => true, probe: async () => false },
  };
  await expect(coordinateRelease(rollbackRequest, gate)).resolves.toMatchObject(
    { decision: "deny" },
  );
  expect(f.rollback).not.toHaveBeenCalled();
  expect(f.begin).not.toHaveBeenCalled();
});
