import { expect, it } from "vitest";
import { coordinateRelease } from "../../scripts/release-coordinator.ts";
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
  "aborts prior to the provider call when the %s changes after staging",
  async (failure) => {
    const f = fixture();
    const begin = f.begin.getMockImplementation()!;
    f.begin.mockImplementationOnce(async (input) => {
      const reserved = await begin(input);
      if (failure === "portfolio head") f.state.head = f.prior.portfolioSha;
      if (failure === "Notes attempt") f.state.notesAttempt++;
      if (failure === "Notes job") f.state.jobConclusion = "failure";
      return reserved;
    });
    await expect(
      coordinateRelease(releaseRequest, f.gate),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(f.abort).toHaveBeenCalledExactlyOnceWith(3);
    expect(f.deploy).not.toHaveBeenCalled();
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
