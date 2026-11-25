import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  probeReleaseMarker,
  releaseMarkerPath,
  verifyReleaseMarker,
} from "./release-build-marker.ts";
import type { createReleaseJournal } from "./release-journal.ts";
import type { createReleasePages } from "./release-pages.ts";
import { evaluateRelease, type ReleaseReceipt } from "./release-policy.ts";
import {
  readReleaseSources,
  type VerifiedRelease,
} from "./release-publication.ts";

type Journal = ReturnType<typeof createReleaseJournal>;
type Pages = ReturnType<typeof createReleasePages>;
type Row = NonNullable<Awaited<ReturnType<Journal["readActive"]>>>;
type Active = Row & { deploymentId: string };
type Reservation = Parameters<Journal["begin"]>[0];
type Stage = Parameters<Pages["deploy"]>[1];

export type ReleaseCoordinatorRequest =
  | { kind: "release"; verified: VerifiedRelease }
  | {
      kind: "rollback";
      expectedActiveId: number;
      knownGoodId: number;
      reference: string;
    }
  | { kind: "recover" };

type Outcome =
  | { decision: "deny"; reason: string }
  | { decision: "noop" }
  | { decision: "confirmed" | "recovered" | "pending"; operationId: number };

export type ReleaseCoordinatorGate = Parameters<
  typeof readReleaseSources
>[1] & {
  origin: string;
  serialized: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  journal: Journal;
  pages: Pages & { readServingDeploymentId: () => Promise<string | undefined> };
  // The staging adapter verifies archive metadata and bytes before providing private static output.
  withStage: (
    receipt: ReleaseReceipt,
    operation: (stage: Stage) => Promise<Outcome>,
  ) => Promise<Outcome>;
  smoke: (receipt: ReleaseReceipt) => Promise<boolean>;
  fetchMarker?: typeof fetch;
  firstCutover?: boolean;
  automaticRestore?: boolean;
  // Replay needs positive terminal evidence tied to the exact interrupted operation.
  proveRestore?: (proof: { pending: Row; prior: Active }) => Promise<boolean>;
  proveFirstCutoverFailure?: (pending: Row) => Promise<boolean>;
};

function deny(reason: string): Outcome {
  return { decision: "deny", reason };
}

function marker(
  origin: string,
  { portfolioSha, notesSha, runId, runAttempt }: ReleaseReceipt,
) {
  return { origin, portfolioSha, notesSha, runId, runAttempt };
}

function requireJournalRow(row: Row | null, transition: string): Row {
  if (!row) throw new Error("Release journal rejected " + transition);
  return row;
}

async function reserve(gate: ReleaseCoordinatorGate, input: Reservation) {
  return requireJournalRow(await gate.journal.begin(input), "reservation");
}

async function close(
  gate: ReleaseCoordinatorGate,
  pending: Row,
  deploymentId: string | null,
  decision: "confirmed" | "recovered",
): Promise<Outcome> {
  const row = deploymentId
    ? await gate.journal.confirmAfterProviderProof(pending.id, deploymentId)
    : await gate.journal.abortAfterProviderProof(pending.id);
  requireJournalRow(row, deploymentId ? "confirmation" : "abort");
  return { decision, operationId: pending.id };
}

async function retained(
  gate: ReleaseCoordinatorGate,
  row: Row,
): Promise<Active | null> {
  if (!row.deploymentId) return null;
  const proof = await gate.pages.readDeployment(
    { receipt: row.receipt },
    row.deploymentId,
  );
  return proof.status === "confirmed" && proof.deploymentId === row.deploymentId
    ? { ...row, deploymentId: row.deploymentId }
    : null;
}

async function canonicalHealth(
  gate: ReleaseCoordinatorGate,
  target: Pick<Active, "receipt" | "deploymentId">,
): Promise<"healthy" | "smoke-failed" | "unknown"> {
  const { receipt, deploymentId } = target;
  if ((await gate.pages.readServingDeploymentId()) !== deploymentId)
    return "unknown";
  const match = await probeReleaseMarker(
    marker(gate.origin, receipt),
    null,
    gate.fetchMarker,
  );
  if (match !== "selected") return "unknown";
  const healthy = await gate.smoke(receipt);
  if ((await gate.pages.readServingDeploymentId()) !== deploymentId)
    return "unknown";
  return healthy === true
    ? "healthy"
    : healthy === false
      ? "smoke-failed"
      : "unknown";
}

async function retainedHealth(gate: ReleaseCoordinatorGate, row: Row) {
  const target = await retained(gate, row);
  return target ? canonicalHealth(gate, target) : "unknown";
}

async function reconcile(
  gate: ReleaseCoordinatorGate,
  pending: Row,
  prior: Row | null,
  fresh: boolean,
): Promise<Outcome> {
  const waiting = { decision: "pending", operationId: pending.id } as const;
  const decision = fresh ? "confirmed" : "recovered";
  if (pending.previousId !== (prior?.id ?? null)) return waiting;

  if (pending.kind === "rollback") {
    const row = await gate.journal.readKnownGood(
      pending.rollbackApproval.knownGoodId,
    );
    if (!row || !isDeepStrictEqual(row.receipt, pending.receipt))
      return waiting;
    const target = await retained(gate, row);
    if (target && (await canonicalHealth(gate, target)) === "healthy")
      return close(gate, pending, target.deploymentId, decision);
    return waiting;
  }

  const { receipt, operationKey } = pending;
  const proof = await gate.pages.observe({ receipt, operationKey });
  if (proof.status === "failed") {
    const safe = prior
      ? (await retainedHealth(gate, prior)) === "healthy"
      : (await gate.proveFirstCutoverFailure?.(pending)) === true;
    return safe ? close(gate, pending, null, "recovered") : waiting;
  }
  if (proof.status !== "confirmed") return waiting;
  const health = await canonicalHealth(gate, {
    receipt,
    deploymentId: proof.deploymentId,
  });
  if (health === "healthy")
    return close(gate, pending, proof.deploymentId, decision);
  if (!prior) return waiting;

  const target = await retained(gate, prior);
  if (!target) return waiting;
  if (!fresh) {
    if (
      (await gate.proveRestore?.({ pending, prior: target })) === true &&
      (await canonicalHealth(gate, target)) === "healthy"
    )
      return close(gate, pending, null, "recovered");
    return waiting;
  }
  if (
    gate.automaticRestore !== true ||
    health !== "smoke-failed" ||
    (await gate.pages.readServingDeploymentId()) !== proof.deploymentId
  )
    return waiting;

  const restored = await gate.pages
    .rollback({ receipt: target.receipt }, target.deploymentId)
    .catch(() => undefined);
  if (
    restored?.status === "confirmed" &&
    restored.deploymentId === target.deploymentId &&
    (await canonicalHealth(gate, target)) === "healthy"
  )
    return close(gate, pending, null, "recovered");
  return waiting;
}

async function release(
  gate: ReleaseCoordinatorGate,
  verified: VerifiedRelease,
  active: Row | null,
): Promise<Outcome> {
  const { receipt } = verified;
  const evidence = async () =>
    evaluateRelease({
      request: { kind: "release", receipt },
      approval: gate.approval,
      active: active?.receipt ?? null,
      verified: receipt,
      artifact: receipt,
      ...(await readReleaseSources(verified, gate)),
    });
  const initial = await evidence();
  if (initial.decision === "deny") return initial;
  if (initial.decision === "noop") return { decision: "noop" };

  return gate.withStage(receipt, async (stage) => {
    const { directory } = stage;
    if (!isAbsolute(directory) || (await realpath(directory)) !== directory)
      throw new Error(
        "Release staging must use the exact private output directory",
      );
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        "Release staging must use the exact private output directory",
      );
    if (!(await lstat(join(directory, releaseMarkerPath))).isFile())
      throw new Error("Release staging marker must be a regular file");
    await verifyReleaseMarker(directory, marker(gate.origin, receipt));

    const { repository, ref, sha, runId } = verified.notesCandidate;
    const pending = await reserve(gate, {
      kind: "release",
      operationKey: randomUUID(),
      expectedActiveId: active?.id ?? null,
      firstCutover: gate.firstCutover === true,
      receipt,
      notesProof: {
        repository,
        repositoryId: gate.approval.notes.repository.id,
        ref,
        sha,
        runId,
        runAttempt: verified.notesRunAttempt,
        workflowId: gate.approval.notes.workflowId,
        jobName: gate.approval.notes.jobName,
        conclusion: "success",
      },
    });

    const current = await evidence();
    if (current.decision !== "publish") {
      await close(gate, pending, null, "recovered");
      return current.decision === "deny"
        ? current
        : deny("Release eligibility changed after staging");
    }

    await gate.pages
      .deploy({ receipt, operationKey: pending.operationKey }, stage)
      .catch(() => undefined);
    return reconcile(gate, pending, active, true);
  });
}

async function rollback(
  gate: ReleaseCoordinatorGate,
  request: Extract<ReleaseCoordinatorRequest, { kind: "rollback" }>,
  active: Row,
  activeHealthy: boolean,
): Promise<Outcome> {
  const { expectedActiveId, knownGoodId, reference } = request;
  if (
    expectedActiveId !== active.id ||
    !Number.isSafeInteger(knownGoodId) ||
    knownGoodId <= 0 ||
    knownGoodId > active.id ||
    typeof reference !== "string" ||
    reference.length > 256 ||
    !reference.trim() ||
    /[\p{Cc}]/u.test(reference)
  )
    return deny(
      "Rollback approval does not identify the current and known-good rows",
    );
  const row = await gate.journal.readKnownGood(knownGoodId);
  const target = row && (await retained(gate, row));
  if (!target) return deny("Known-good provider deployment is unavailable");
  if (
    target.deploymentId === active.deploymentId &&
    isDeepStrictEqual(target.receipt, active.receipt)
  )
    return activeHealthy
      ? { decision: "noop" }
      : deny("The requested rollback already serves the unhealthy release");

  const pending = await reserve(gate, {
    kind: "rollback",
    operationKey: randomUUID(),
    expectedActiveId,
    receipt: target.receipt,
    rollbackApproval: { knownGoodId, reference },
  });
  await gate.pages
    .rollback({ receipt: target.receipt }, target.deploymentId)
    .catch(() => undefined);
  return reconcile(gate, pending, active, true);
}

export function coordinateRelease(
  input: ReleaseCoordinatorRequest,
  gate: ReleaseCoordinatorGate,
): Promise<Outcome> {
  const request = structuredClone(input);
  return gate.serialized(async () => {
    const pending = await gate.journal.readPending();
    const active = await gate.journal.readActive();
    if (pending) return reconcile(gate, pending, active, false);
    const health = active ? await retainedHealth(gate, active) : "unknown";
    if (
      active &&
      health !== "healthy" &&
      !(request.kind === "rollback" && health === "smoke-failed")
    )
      return deny(
        "Active deployment identity and canonical health could not be proved",
      );
    if (request.kind === "recover") return { decision: "noop" };
    if (request.kind === "rollback") {
      if (!active) return deny("Rollback requires an active deployment");
      return rollback(gate, request, active, health === "healthy");
    }
    if (active === null && gate.firstCutover !== true)
      return deny("First cutover requires explicit approval");
    return release(gate, request.verified, active);
  });
}
