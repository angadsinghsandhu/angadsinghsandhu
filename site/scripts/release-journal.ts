import { z } from "zod";
import {
  releaseArtifactIdentity,
  releaseReceiptSchema,
} from "./release-artifact-download.ts";

const id = z.number().int().positive();
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u);
const auditText = z
  .string()
  .max(256)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}]/u.test(value));
const commit = releaseArtifactIdentity.shape.portfolioSha;
const notesProof = z.strictObject({
  repository: z
    .string()
    .max(256)
    .regex(/^[\w-][\w.-]*\/[\w-][\w.-]*(?![\s\S])/u),
  repositoryId: id,
  ref: z
    .string()
    .regex(/^refs\/heads\/\S+(?![\s\S])/u)
    .max(256),
  sha: commit,
  workflowId: id,
  runId: id,
  runAttempt: id,
  jobName: auditText,
  conclusion: z.literal("success"),
});
const rollbackApproval = z.strictObject({
  knownGoodId: id,
  reference: auditText,
});
const release = z.strictObject({
  kind: z.literal("release"),
  receipt: releaseReceiptSchema,
  notesProof,
});
const rollback = z.strictObject({
  kind: z.literal("rollback"),
  receipt: releaseReceiptSchema,
  rollbackApproval,
});
const operation = z
  .discriminatedUnion("kind", [release, rollback])
  .refine(
    (value) =>
      value.kind === "rollback" ||
      value.notesProof.sha === value.receipt.notesSha,
  );
const beginFields = {
  operationKey: uuid,
  expectedActiveId: id.nullable(),
  firstCutover: z.boolean().optional(),
};
const start = z
  .discriminatedUnion("kind", [
    release.extend(beginFields),
    rollback.extend(beginFields),
  ])
  .refine(
    (value) =>
      value.kind === "rollback" ||
      value.notesProof.sha === value.receipt.notesSha,
  );
const configSchema = z.strictObject({
  accountId: z.string().regex(/^[0-9a-f]{32}(?![\s\S])/u),
  databaseId: uuid,
  project: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?(?![\s\S])/u),
  origin: z
    .string()
    .max(300)
    .refine((value) => {
      const url = URL.parse(value);
      return url?.protocol === "https:" && url.origin === value;
    }),
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(?![\s\S])/u)
    .max(256),
});

const rowSchema = z.strictObject({
  target: z.string(),
  id,
  previousId: id.nullable(),
  kind: z.enum(["release", "rollback"]),
  operationKey: uuid,
  receipt: z.string(),
  proof: z.string(),
  rollbackId: id.nullable(),
  state: z.enum(["pending", "confirmed", "aborted"]),
  deploymentId: uuid.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
const envelope = z.object({
  success: z.literal(true),
  errors: z.tuple([]),
  result: z.tuple([
    z.object({ success: z.literal(true), results: z.array(rowSchema).max(1) }),
  ]),
});

type State = z.infer<typeof rowSchema>["state"];

function readRow(
  input: z.infer<typeof rowSchema>,
  target: string,
  state: State,
) {
  const {
    target: actualTarget,
    kind,
    receipt,
    proof,
    rollbackId,
    ...row
  } = input;
  const facts = operation.parse({
    kind,
    receipt: JSON.parse(receipt),
    [kind === "release" ? "notesProof" : "rollbackApproval"]: JSON.parse(proof),
  });
  if (
    actualTarget !== target ||
    row.state !== state ||
    (row.deploymentId !== null) !== (state === "confirmed") ||
    (row.finishedAt === null) !== (state === "pending") ||
    (row.previousId !== null && row.previousId >= row.id) ||
    (facts.kind === "rollback" &&
      (row.previousId === null ||
        facts.rollbackApproval.knownGoodId >= row.id)) ||
    rollbackId !==
      (facts.kind === "rollback" ? facts.rollbackApproval.knownGoodId : null)
  ) {
    throw new Error();
  }
  return { ...row, ...facts };
}

const beginSql = `
  INSERT INTO release_operations (target, id, operationKey, previousId, kind, receipt, proof, rollbackId)
  SELECT ?1, COALESCE((SELECT MAX(id) FROM release_operations WHERE target = ?1), 0) + 1,
    ?2, CAST(NULLIF(?3, '') AS INTEGER), ?4, ?5, ?6, CAST(NULLIF(?7, '') AS INTEGER)
  WHERE (SELECT MAX(id) FROM release_operations WHERE target = ?1 AND state = 'confirmed')
    IS CAST(NULLIF(?3, '') AS INTEGER)
    AND (?3 != '' OR ?8 = 'first-cutover')
    AND NOT EXISTS (SELECT 1 FROM release_operations WHERE target = ?1 AND state = 'pending')
    AND NOT EXISTS (SELECT 1 FROM release_operations WHERE target = ?1 AND operationKey = ?2)
    AND (?4 = 'release' OR EXISTS (
      SELECT 1 FROM release_operations
      WHERE target = ?1 AND id = CAST(?7 AS INTEGER) AND state = 'confirmed' AND receipt = ?5
    ))
  RETURNING *
`;

const finishSql = `
  UPDATE release_operations SET
    state = ?3,
    deploymentId = NULLIF(?4, ''),
    finishedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE target = ?1 AND id = CAST(?2 AS INTEGER) AND state = 'pending'
    AND (?3 = 'aborted' OR kind = 'release' OR ?4 = (
      SELECT known.deploymentId FROM release_operations AS known
      WHERE known.target = ?1 AND known.id = release_operations.rollbackId AND known.state = 'confirmed'
    ))
  RETURNING *
`;

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted || response.status !== 200 || response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();

  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) throw new Error();
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function createReleaseJournal(
  config: z.input<typeof configSchema>,
  http = fetch,
) {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error("Invalid release journal configuration");
  const { accountId, databaseId, project, origin, token } = parsed.data;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const target = JSON.stringify([accountId, project, origin]);

  async function query(
    sql: string,
    state: State,
    parameters: string[] = [],
    matches: (row: ReturnType<typeof readRow>) => boolean = () => true,
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const request = http(url, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ sql, params: [target, ...parameters] }),
        signal: controller.signal,
      }).then((response) => readResponse(response, controller.signal));
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error());
        }, 15_000);
      });
      const payload = await Promise.race([request, deadline]);
      const [
        {
          results: [result],
        },
      ] = envelope.parse(payload).result;
      if (!result) return null;
      const row = readRow(result, target, state);
      if (!matches(row)) throw new Error();
      return row;
    } catch {
      throw new Error("Release journal query failed");
    } finally {
      clearTimeout(timer);
    }
  }

  function finish(
    operationId: number,
    state: "confirmed" | "aborted",
    deploymentId: string,
  ) {
    if (
      !id.safeParse(operationId).success ||
      (state === "confirmed" && !uuid.safeParse(deploymentId).success)
    ) {
      throw new Error("Invalid release journal input");
    }
    return query(
      finishSql,
      state,
      [String(operationId), state, deploymentId],
      (row) =>
        row.id === operationId && row.deploymentId === (deploymentId || null),
    );
  }

  return {
    readActive: () =>
      query(
        "SELECT * FROM release_operations WHERE target = ?1 AND state = 'confirmed' ORDER BY id DESC LIMIT 1",
        "confirmed",
      ),
    readPending: () =>
      query(
        "SELECT * FROM release_operations WHERE target = ?1 AND state = 'pending'",
        "pending",
      ),
    async readKnownGood(operationId: number) {
      if (!id.safeParse(operationId).success)
        throw new Error("Invalid release journal input");
      return query(
        "SELECT * FROM release_operations WHERE target = ?1 AND id = CAST(?2 AS INTEGER) AND state = 'confirmed'",
        "confirmed",
        [String(operationId)],
        (row) => row.id === operationId,
      );
    },
    async begin(input: z.input<typeof start>) {
      const checked = start.safeParse(input);
      if (!checked.success) throw new Error("Invalid release journal input");
      const value = checked.data;
      const proof =
        value.kind === "release" ? value.notesProof : value.rollbackApproval;
      const exactReceipt = JSON.stringify(value.receipt);
      const exactProof = JSON.stringify(proof);
      return query(
        beginSql,
        "pending",
        [
          value.operationKey,
          String(value.expectedActiveId ?? ""),
          value.kind,
          exactReceipt,
          exactProof,
          value.kind === "rollback"
            ? String(value.rollbackApproval.knownGoodId)
            : "",
          value.firstCutover === true ? "first-cutover" : "",
        ],
        (row) =>
          row.operationKey === value.operationKey &&
          row.previousId === value.expectedActiveId &&
          row.kind === value.kind &&
          JSON.stringify(row.receipt) === exactReceipt &&
          JSON.stringify(
            row.kind === "release" ? row.notesProof : row.rollbackApproval,
          ) === exactProof,
      );
    },
    async confirmAfterProviderProof(operationId: number, deploymentId: string) {
      return finish(operationId, "confirmed", deploymentId);
    },
    async abortAfterProviderProof(operationId: number) {
      return finish(operationId, "aborted", "");
    },
  };
}
