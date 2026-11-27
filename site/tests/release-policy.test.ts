import { describe, expect, it } from "vitest";
import {
  evaluateNotesRevision,
  evaluateRelease,
  type EligibilityEvidence,
  type ReleaseEvidence,
} from "../scripts/release-policy";

const notesSha = "a".repeat(40);
const portfolioSha = "b".repeat(40);
const previousSha = "c".repeat(40);
const repository = { id: 1, name: "example/notes" };
const portfolioRepository = { id: 2, name: "example/portfolio" };
const ref = "refs/heads/publish";
const portfolioRef = "refs/heads/main";
const candidate = { repository: repository.name, ref, sha: notesSha, runId: 3 };
const approval = { repository, ref, workflowId: 4, jobName: "verify" };
const head = { repository, ref, sha: notesSha, protected: true };
const run = {
  id: 3,
  attempt: 1,
  repository,
  headRepository: repository,
  ref,
  sha: notesSha,
  workflowId: 4,
  event: "push",
  status: "completed",
  conclusion: "success",
};
const job = {
  runId: 3,
  runAttempt: 1,
  name: "verify",
  sha: notesSha,
  status: "completed",
  conclusion: "success",
};
const evidence: EligibilityEvidence = { approval, head, run, job };

describe("Notes eligibility", () => {
  it("accepts matching successful proof for the current approved head", () => {
    expect(evaluateNotesRevision(candidate, evidence).decision).toBe(
      "eligible",
    );
  });

  it.each([undefined, null])(
    "denies an absent dispatch candidate (%s)",
    (absent) => {
      expect(evaluateNotesRevision(absent, evidence).decision).toBe("deny");
    },
  );

  it.each([
    ["unknown repository", { repository: "example/other" }],
    ["unapproved ref", { ref: "refs/heads/main" }],
    ["abbreviated SHA", { sha: "aaaaaaa" }],
    ["uppercase SHA", { sha: notesSha.toUpperCase() }],
    ["SHA with trailing newline", { sha: notesSha + "\n" }],
    ["wrong requested run", { runId: 99 }],
  ])("denies a candidate with %s", (_name, change) => {
    expect(
      evaluateNotesRevision({ ...candidate, ...change }, evidence).decision,
    ).toBe("deny");
  });

  it.each([
    ["no approval", { approval: undefined }],
    ["missing head", { head: undefined }],
    [
      "invalid repository ID",
      { head: { ...head, repository: { ...repository, id: 0 } } },
    ],
    ["unprotected head", { head: { ...head, protected: false } }],
    ["superseded candidate", { head: { ...head, sha: previousSha } }],
    ["missing run", { run: undefined }],
    ["different workflow", { run: { ...run, workflowId: 99 } }],
    [
      "different repository",
      { run: { ...run, repository: portfolioRepository } },
    ],
    [
      "forked head repository",
      { run: { ...run, headRepository: portfolioRepository } },
    ],
    ["different ref", { run: { ...run, ref: portfolioRef } }],
    ["pull request proof", { run: { ...run, event: "pull_request" } }],
    ["unsuccessful run", { run: { ...run, conclusion: "failure" } }],
    ["incomplete run", { run: { ...run, status: "in_progress" } }],
    ["different run SHA", { run: { ...run, sha: previousSha } }],
    ["missing job", { job: undefined }],
    ["different job", { job: { ...job, name: "build" } }],
    ["different job run", { job: { ...job, runId: 99 } }],
    ["different run attempt", { job: { ...job, runAttempt: 2 } }],
    ["different job SHA", { job: { ...job, sha: previousSha } }],
    ["skipped job", { job: { ...job, conclusion: "skipped" } }],
    ["incomplete job", { job: { ...job, status: "in_progress" } }],
  ] satisfies [string, EligibilityEvidence][])("denies %s", (_name, change) => {
    expect(
      evaluateNotesRevision(candidate, { ...evidence, ...change }).decision,
    ).toBe("deny");
  });
});

const receipt = {
  portfolioSha,
  notesSha,
  snapshotSchema: 1,
  runId: 11,
  runAttempt: 1,
  artifactId: 12,
  manifestSha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
};
const artifact = {
  runId: receipt.runId,
  runAttempt: receipt.runAttempt,
  artifactId: receipt.artifactId,
  archiveSha256: receipt.archiveSha256,
};
const releaseApproval = {
  portfolio: { repository: portfolioRepository, ref: portfolioRef },
  notes: approval,
};
const release = {
  request: { kind: "release", receipt },
  approval: releaseApproval,
  portfolioHead: {
    repository: portfolioRepository,
    ref: portfolioRef,
    sha: portfolioSha,
    protected: true,
  },
  notesHead: head,
  notesProof: { candidate, run, job },
  verified: receipt,
  artifact,
  active: null,
} satisfies ReleaseEvidence;

describe("serialized upload decision", () => {
  it("permits the digest-bound artifact for a fresh pair", () => {
    expect(evaluateRelease(release).decision).toBe("publish");
  });

  it.each([
    ["unapproved source policy", { approval: undefined }],
    [
      "a newer Portfolio head",
      { portfolioHead: { ...release.portfolioHead, sha: previousSha } },
    ],
    ["a newer Notes head", { notesHead: { ...head, sha: previousSha } }],
    [
      "a head from another repository",
      { notesHead: { ...head, repository: portfolioRepository } },
    ],
    [
      "an unprotected Portfolio ref",
      { portfolioHead: { ...release.portfolioHead, protected: false } },
    ],
    ["missing Notes check proof", { notesProof: undefined }],
    [
      "the wrong Notes job",
      { notesProof: { candidate, run, job: { ...job, name: "other" } } },
    ],
    ["missing check receipt", { verified: undefined }],
    [
      "a mismatched verified snapshot schema",
      { verified: { ...receipt, snapshotSchema: 2 } },
    ],
    [
      "a mismatched verified manifest digest",
      { verified: { ...receipt, manifestSha256: "f".repeat(64) } },
    ],
    ["no artifact", { artifact: undefined }],
    ["an artifact from another run", { artifact: { ...artifact, runId: 13 } }],
    [
      "an artifact from another run attempt",
      { artifact: { ...artifact, runAttempt: 2 } },
    ],
    ["a different artifact ID", { artifact: { ...artifact, artifactId: 13 } }],
    [
      "different archive bytes",
      { artifact: { ...artifact, archiveSha256: "f".repeat(64) } },
    ],
    ["unknown active release state", { active: undefined }],
  ] satisfies [string, Partial<ReleaseEvidence>][])(
    "denies %s",
    (_name, change) => {
      expect(evaluateRelease({ ...release, ...change }).decision).toBe("deny");
    },
  );

  it("returns a no-op when the currently active known-good receipt already has the pair", () => {
    const active = { ...receipt, runId: 21, artifactId: 22 };
    expect(evaluateRelease({ ...release, active }).decision).toBe("noop");
  });

  it("denies a stale request even if its pair is currently active", () => {
    const notesHead = { ...head, sha: previousSha };
    expect(
      evaluateRelease({ ...release, active: receipt, notesHead }).decision,
    ).toBe("deny");
  });

  const rollback: ReleaseEvidence = {
    ...release,
    request: { kind: "rollback", receipt },
    portfolioHead: undefined,
    notesHead: undefined,
    notesProof: undefined,
    verified: undefined,
    active: { ...receipt, notesSha: previousSha },
    authorizedRollback: receipt,
  };

  it("permits explicitly authorized restoration of the exact retained known-good artifact", () => {
    expect(evaluateRelease(rollback).decision).toBe("publish");
  });

  it.each([
    ["without authorization", { authorizedRollback: undefined }],
    ["without production source approval", { approval: undefined }],
    [
      "for an unapproved receipt",
      { authorizedRollback: { ...receipt, notesSha: previousSha } },
    ],
    [
      "with substituted bytes",
      { artifact: { ...artifact, archiveSha256: "0".repeat(64) } },
    ],
  ] satisfies [string, Partial<ReleaseEvidence>][])(
    "denies rollback %s",
    (_name, change) => {
      expect(evaluateRelease({ ...rollback, ...change }).decision).toBe("deny");
    },
  );

  it("returns a no-op when retrying restoration of the exact active receipt", () => {
    expect(evaluateRelease({ ...rollback, active: receipt }).decision).toBe(
      "noop",
    );
  });

  it("permits restoring the known-good artifact when the same pair uses another artifact", () => {
    expect(
      evaluateRelease({ ...rollback, active: { ...receipt, artifactId: 99 } })
        .decision,
    ).toBe("publish");
  });
});

it("requires an exact paired Pages and Worker identity in the verified receipt", () => {
  const practice = {
    pagesSha256: "a".repeat(64),
    workerSha256: "b".repeat(64),
    workerFiles: 1,
  };
  const paired = { ...receipt, practice };
  const evidence: ReleaseEvidence = {
    ...release,
    request: { kind: "release", receipt: paired },
    verified: paired,
  };
  expect(evaluateRelease(evidence).decision).toBe("publish");
  expect(evaluateRelease({ ...evidence, verified: receipt }).decision).toBe(
    "deny",
  );
  expect(
    evaluateRelease({
      ...evidence,
      verified: {
        ...paired,
        practice: { ...practice, workerSha256: "c".repeat(64) },
      },
    }).decision,
  ).toBe("deny");
  const invalid = { ...paired, practice: { ...practice, workerFiles: 0 } };
  expect(
    evaluateRelease({
      ...evidence,
      request: { kind: "release", receipt: invalid },
      verified: invalid,
    }).decision,
  ).toBe("deny");
});
