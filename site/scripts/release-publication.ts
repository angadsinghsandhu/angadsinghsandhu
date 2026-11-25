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

type PublicationGate = {
  approval: NonNullable<ReleaseEvidence["approval"]>;
  serialized: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  sourceApi: Parameters<typeof readProtectedHead>[1];
  artifact: Parameters<typeof readReleaseArtifactArchive>[1];
  readActive: () => Promise<ReleaseReceipt | null | undefined>;
  readVerified: (
    receipt: ReleaseReceipt,
  ) => Promise<
    { receipt: ReleaseReceipt; notesCandidate: NotesCandidate } | undefined
  >;
  readAuthorizedRollback: (
    receipt: ReleaseReceipt,
  ) => Promise<ReleaseReceipt | undefined>;
  activate: (receipt: ReleaseReceipt, archive: Uint8Array) => Promise<void>;
};

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
    const { approval, sourceApi } = gate;
    const [portfolioHead, notes] = verified
      ? await Promise.all([
          readProtectedHead(approval.portfolio, sourceApi),
          readNotesEvidence(verified.notesCandidate, approval.notes, sourceApi),
        ])
      : [];
    const evidence: ReleaseEvidence = {
      request,
      approval,
      active,
      verified: verified?.receipt,
      authorizedRollback,
      portfolioHead,
      notesHead: notes?.head,
      notesProof: verified && {
        candidate: verified.notesCandidate,
        run: notes?.run,
        job: notes?.job,
      },
      // Preflight uses the trusted receipt. Activation requires the current metadata and checked bytes.
      artifact: verified?.receipt ?? authorizedRollback,
    };

    const decision = evaluateRelease(evidence);
    if (decision.decision !== "publish") return decision;

    const archive = await readReleaseArtifactArchive(receipt, gate.artifact);
    if (verified) {
      const [portfolioHead, notesHead] = await Promise.all([
        readProtectedHead(approval.portfolio, sourceApi),
        readProtectedHead(approval.notes, sourceApi),
      ]);
      const refreshed = evaluateRelease({
        ...evidence,
        portfolioHead,
        notesHead,
      });
      if (refreshed.decision !== "publish") return refreshed;
    }
    await gate.activate(receipt, archive);
    return decision;
  });
}
