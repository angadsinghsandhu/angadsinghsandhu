import { readReleaseArtifactArchive } from "./release-artifact-download.ts";
import {
  evaluateRelease,
  type NotesCandidate,
  type ReleaseEvidence,
  type ReleaseReceipt,
} from "./release-policy.ts";
import {
  readNotesEvidence,
  readProtectedHead,
} from "./release-source-proof.ts";

export type VerifiedRelease = {
  receipt: ReleaseReceipt;
  notesCandidate: NotesCandidate;
  notesRunAttempt: number;
};

type PublicationGate = {
  approval: NonNullable<ReleaseEvidence["approval"]>;
  serialized: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  sourceApi: Parameters<typeof readProtectedHead>[1];
  artifact: Parameters<typeof readReleaseArtifactArchive>[1];
  readActive: () => Promise<ReleaseReceipt | null | undefined>;
  readVerified: (
    receipt: ReleaseReceipt,
  ) => Promise<VerifiedRelease | undefined>;
  readAuthorizedRollback: (
    receipt: ReleaseReceipt,
  ) => Promise<ReleaseReceipt | undefined>;
  activate: (receipt: ReleaseReceipt, archive: Uint8Array) => Promise<void>;
};

export async function readReleaseSources(
  verified: VerifiedRelease,
  { approval, sourceApi }: Pick<PublicationGate, "approval" | "sourceApi">,
): Promise<
  Pick<ReleaseEvidence, "portfolioHead" | "notesHead" | "notesProof">
> {
  const { notesCandidate, notesRunAttempt } = verified;
  const [portfolioHead, notes] = await Promise.all([
    readProtectedHead(approval.portfolio, sourceApi),
    readNotesEvidence(notesCandidate, approval.notes, sourceApi),
  ]);
  return {
    portfolioHead,
    notesHead: notes.head,
    notesProof: {
      candidate: notesCandidate,
      run: notes.run?.attempt === notesRunAttempt ? notes.run : undefined,
      job: notes.job?.runAttempt === notesRunAttempt ? notes.job : undefined,
    },
  };
}

export function publishRelease(
  input: ReleaseEvidence["request"],
  gate: PublicationGate,
): Promise<ReturnType<typeof evaluateRelease>> {
  const request = { kind: input.kind, receipt: { ...input.receipt } };
  return gate.serialized(async () => {
    const { kind, receipt } = request;
    const active = await gate.readActive();
    const verified =
      kind === "release" ? await gate.readVerified(receipt) : undefined;
    const authorizedRollback =
      kind === "rollback"
        ? await gate.readAuthorizedRollback(receipt)
        : undefined;
    const evidence: ReleaseEvidence = {
      request,
      approval: gate.approval,
      active,
      verified: verified?.receipt,
      authorizedRollback,
      ...(verified && (await readReleaseSources(verified, gate))),
      // Preflight uses the trusted receipt. Activation requires the current metadata and checked bytes.
      artifact: verified?.receipt ?? authorizedRollback,
    };

    const decision = evaluateRelease(evidence);
    if (decision.decision !== "publish") return decision;

    const archive = await readReleaseArtifactArchive(receipt, gate.artifact);
    if (verified) {
      const refreshed = evaluateRelease({
        ...evidence,
        ...(await readReleaseSources(verified, gate)),
      });
      if (refreshed.decision !== "publish") return refreshed;
    }
    await gate.activate(receipt, archive);
    return decision;
  });
}
