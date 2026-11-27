import { z } from "zod";
import { artifactMaxFiles } from "./stage-practice-traces.ts";
import type { PracticeBundleProof } from "./verify-practice-bundle.ts";

type Repository = {
  id: number;
  name: string;
};

type ProtectedSource = {
  repository: Repository;
  ref: string;
};

type NotesApproval = ProtectedSource & {
  workflowId: number;
  jobName: string;
};

type ProtectedHead = ProtectedSource & {
  sha: string;
  protected: boolean;
};

export type NotesCandidate = {
  repository: string;
  ref: string;
  sha: string;
  runId: number;
};

type CompletedCheck = {
  status: string;
  conclusion: string | null;
  sha: string;
};

export type EligibilityEvidence = {
  approval?: NotesApproval;
  head?: ProtectedHead;
  run?: ProtectedSource &
    CompletedCheck & {
      id: number;
      attempt: number;
      headRepository: Repository;
      workflowId: number;
      event: string;
    };
  job?: CompletedCheck & {
    name: string;
    runId: number;
    runAttempt: number;
  };
};

type Denial = {
  decision: "deny";
  reason: string;
};

export type EligibilityResult = { decision: "eligible" } | Denial;

type CheckedArtifact = {
  runId: number;
  runAttempt: number;
  artifactId: number;
  archiveSha256: string;
};

export type ReleaseReceipt = CheckedArtifact & {
  portfolioSha: string;
  notesSha: string;
  snapshotSchema: number;
  manifestSha256: string;
  practice?: PracticeBundleProof;
};

export type ReleaseEvidence = {
  request: { kind: "release" | "rollback"; receipt: ReleaseReceipt };
  approval?: { portfolio: ProtectedSource; notes: NotesApproval };
  portfolioHead?: ProtectedHead;
  notesHead?: ProtectedHead;
  notesProof?: Pick<EligibilityEvidence, "run" | "job"> & {
    candidate: NotesCandidate;
  };
  verified?: ReleaseReceipt;
  artifact?: CheckedArtifact;
  active?: ReleaseReceipt | null;
  authorizedRollback?: ReleaseReceipt;
};

type ReleaseResult = { decision: "publish" | "noop" } | Denial;

const commitSha = /^[0-9a-f]{40}(?![\s\S])/u;
const sha256 = /^[0-9a-f]{64}(?![\s\S])/u;

export const practiceBundleProofSchema = z.strictObject({
  pagesSha256: z.string().regex(sha256),
  workerSha256: z.string().regex(sha256),
  workerFiles: z.number().int().positive().max(artifactMaxFiles),
});

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validSource(source: ProtectedSource): boolean {
  return (
    positiveId(source.repository?.id) &&
    /^[\w.-]+\/[\w.-]+(?![\s\S])/u.test(source.repository.name) &&
    /^refs\/heads\/\S+(?![\s\S])/u.test(source.ref)
  );
}

function validNotesApproval(approval: NotesApproval): boolean {
  return (
    validSource(approval) &&
    positiveId(approval.workflowId) &&
    typeof approval.jobName === "string" &&
    approval.jobName.trim().length > 0
  );
}

function sameRepository(actual: Repository, expected: Repository): boolean {
  return actual?.id === expected.id && actual.name === expected.name;
}

function matchesHead(
  head: ProtectedHead | undefined,
  source: ProtectedSource,
  sha: string,
): boolean {
  return (
    head?.protected === true &&
    sameRepository(head.repository, source.repository) &&
    head.ref === source.ref &&
    head.sha === sha
  );
}

function passedAt(check: CompletedCheck, sha: string): boolean {
  return (
    check.status === "completed" &&
    check.conclusion === "success" &&
    check.sha === sha
  );
}

function deny(reason: string): Denial {
  return { decision: "deny", reason };
}

// Evidence must come from the authenticated GitHub reads, never the dispatch payload.
export function evaluateNotesRevision(
  candidate: NotesCandidate | null | undefined,
  { approval, head, run, job }: EligibilityEvidence,
): EligibilityResult {
  if (
    !candidate ||
    !approval ||
    !validNotesApproval(approval) ||
    candidate.repository !== approval.repository.name ||
    candidate.ref !== approval.ref ||
    !commitSha.test(candidate.sha) ||
    !positiveId(candidate.runId)
  ) {
    return deny("Notes candidate is outside the approved source policy");
  }

  if (!matchesHead(head, approval, candidate.sha)) {
    return deny("Notes candidate is not the current protected head");
  }

  if (
    !run ||
    run.id !== candidate.runId ||
    !positiveId(run.attempt) ||
    run.workflowId !== approval.workflowId ||
    !sameRepository(run.repository, approval.repository) ||
    !sameRepository(run.headRepository, approval.repository) ||
    run.ref !== approval.ref ||
    run.event !== "push" ||
    !passedAt(run, candidate.sha)
  ) {
    return deny("Notes verification run does not match the approved revision");
  }

  if (
    !job ||
    job.runId !== run.id ||
    job.runAttempt !== run.attempt ||
    job.name !== approval.jobName ||
    !passedAt(job, candidate.sha)
  ) {
    return deny(
      "Notes verification job did not pass for the approved revision",
    );
  }

  return { decision: "eligible" };
}

function samePair(actual: ReleaseReceipt, expected: ReleaseReceipt): boolean {
  return (
    actual.portfolioSha === expected.portfolioSha &&
    actual.notesSha === expected.notesSha
  );
}

function sameArtifact(
  actual: CheckedArtifact,
  expected: CheckedArtifact,
): boolean {
  return (
    actual.runId === expected.runId &&
    actual.runAttempt === expected.runAttempt &&
    actual.artifactId === expected.artifactId &&
    actual.archiveSha256 === expected.archiveSha256
  );
}

function samePractice(
  actual: PracticeBundleProof | undefined,
  expected: PracticeBundleProof | undefined,
): boolean {
  if (!actual || !expected) return actual === expected;
  return (
    actual.pagesSha256 === expected.pagesSha256 &&
    actual.workerSha256 === expected.workerSha256 &&
    actual.workerFiles === expected.workerFiles
  );
}

function sameReceipt(
  actual: ReleaseReceipt,
  expected: ReleaseReceipt,
): boolean {
  return (
    samePair(actual, expected) &&
    sameArtifact(actual, expected) &&
    actual.snapshotSchema === expected.snapshotSchema &&
    actual.manifestSha256 === expected.manifestSha256 &&
    samePractice(actual.practice, expected.practice)
  );
}

function validReceipt(receipt: ReleaseReceipt): boolean {
  return (
    commitSha.test(receipt.portfolioSha) &&
    commitSha.test(receipt.notesSha) &&
    positiveId(receipt.snapshotSchema) &&
    positiveId(receipt.runId) &&
    positiveId(receipt.runAttempt) &&
    positiveId(receipt.artifactId) &&
    sha256.test(receipt.manifestSha256) &&
    sha256.test(receipt.archiveSha256) &&
    (receipt.practice === undefined ||
      practiceBundleProofSchema.safeParse(receipt.practice).success)
  );
}

// Call inside the upload gate with freshly read heads and the active known-good receipt.
export function evaluateRelease({
  request,
  approval,
  portfolioHead,
  notesHead,
  notesProof,
  verified,
  artifact,
  active,
  authorizedRollback,
}: ReleaseEvidence): ReleaseResult {
  if (
    !approval ||
    !approval.portfolio ||
    !validSource(approval.portfolio) ||
    !approval.notes ||
    !validNotesApproval(approval.notes)
  ) {
    return deny("Production source policy is missing or invalid");
  }

  const receipt = request?.receipt;
  if (
    !receipt ||
    !validReceipt(receipt) ||
    !artifact ||
    !sameArtifact(artifact, receipt)
  ) {
    return deny("Artifact does not match the release receipt");
  }

  if (active !== null && (!active || !validReceipt(active))) {
    return deny("Active release state is unknown");
  }

  if (request.kind === "rollback") {
    if (!authorizedRollback || !sameReceipt(authorizedRollback, receipt)) {
      return deny(
        "Rollback requires authorization for the retained known-good receipt",
      );
    }
    return {
      decision: active && sameReceipt(active, receipt) ? "noop" : "publish",
    };
  }

  if (
    request.kind !== "release" ||
    !verified ||
    !sameReceipt(verified, receipt)
  ) {
    return deny("Release receipt does not match the verified build");
  }

  if (!matchesHead(portfolioHead, approval.portfolio, receipt.portfolioSha)) {
    return deny("Portfolio revision is not the current protected head");
  }

  if (!notesProof?.candidate || notesProof.candidate.sha !== receipt.notesSha) {
    return deny("Notes proof does not match the release receipt");
  }
  const notes = evaluateNotesRevision(notesProof.candidate, {
    approval: approval.notes,
    head: notesHead,
    run: notesProof.run,
    job: notesProof.job,
  });
  if (notes.decision === "deny") return notes;

  return { decision: active && samePair(active, receipt) ? "noop" : "publish" };
}
