import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { createReleaseJournal } from "../../scripts/release-journal.ts";

const config = {
  accountId: "a".repeat(32),
  databaseId: "00000000-0000-4000-8000-000000000001",
  project: "portfolio",
  origin: "https://portfolio.example",
  token: "private-token",
};
const deploymentId = "10000000-0000-4000-8000-000000000001";
const nextDeploymentId = "10000000-0000-4000-8000-000000000002";
const receipt = {
  portfolioSha: "a".repeat(40),
  notesSha: "b".repeat(40),
  snapshotSchema: 1,
  manifestSha256: "c".repeat(64),
  runId: 123,
  runAttempt: 1,
  artifactId: 456,
  archiveSha256: "d".repeat(64),
};
const proof = {
  repository: "owner/Notes",
  repositoryId: 111,
  ref: "refs/heads/main",
  sha: receipt.notesSha,
  workflowId: 222,
  runId: 333,
  runAttempt: 2,
  jobName: "verify",
  conclusion: "success" as const,
};
const request = (expectedActiveId: number | null) => ({
  kind: "release" as const,
  receipt,
  notesProof: proof,
  operationKey: randomUUID(),
  expectedActiveId,
});

const dispose: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (dispose.length) dispose.pop()?.();
});

function openJournals() {
  const directory = mkdtempSync(join(tmpdir(), "portfolio-journal-"));
  dispose.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "journal.sqlite");
  const first = new DatabaseSync(filename);
  const second = new DatabaseSync(filename);
  dispose.push(
    () => first.close(),
    () => second.close(),
  );
  first.exec(
    readFileSync(
      new URL("../../scripts/release-journal.sql", import.meta.url),
      "utf8",
    ),
  );

  const fetchWith =
    (db: DatabaseSync): typeof fetch =>
    async (_, options) => {
      const { sql, params } = JSON.parse(String(options?.body)) as {
        sql: string;
        params: string[];
      };
      expect(params.every((parameter) => typeof parameter === "string")).toBe(
        true,
      );
      const bindings = Object.fromEntries(
        params.map((parameter, index) => [`?${index + 1}`, parameter]),
      );
      const results = db.prepare(sql).all(bindings);
      return Response.json({
        success: true,
        errors: [],
        result: [{ success: true, results }],
      });
    };

  return {
    first,
    writer: createReleaseJournal(config, fetchWith(first)),
    reader: createReleaseJournal(config, fetchWith(second)),
    other: createReleaseJournal(
      { ...config, project: "secondary" },
      fetchWith(second),
    ),
  };
}

test("reserves exactly one pending operation and confirms it against the observed active ID", async () => {
  const { writer, reader, other } = openJournals();
  expect(await reader.readActive()).toBeNull();
  expect(await writer.begin(request(null))).toBeNull();

  const start = { ...request(null), firstCutover: true };
  const [pending, declined] = await Promise.all([
    writer.begin(start),
    reader.begin({ ...start, operationKey: randomUUID() }),
  ]);
  expect(pending).toMatchObject({
    id: 1,
    previousId: null,
    state: "pending",
    deploymentId: null,
    receipt,
    operationKey: start.operationKey,
    notesProof: proof,
  });
  expect(declined).toBeNull();
  expect(await reader.readPending()).toEqual(pending);
  expect(await reader.readActive()).toBeNull();
  expect(await reader.readKnownGood(1)).toBeNull();
  expect(await reader.confirmAfterProviderProof(2, deploymentId)).toBeNull();
  expect(await other.confirmAfterProviderProof(1, deploymentId)).toBeNull();

  const confirmed = await reader.confirmAfterProviderProof(1, deploymentId);
  expect(confirmed).toMatchObject({ id: 1, state: "confirmed", deploymentId });
  expect(await writer.readActive()).toEqual(confirmed);
  expect(await writer.readKnownGood(1)).toEqual(confirmed);
  expect(await writer.readPending()).toBeNull();
  expect(await writer.confirmAfterProviderProof(1, deploymentId)).toBeNull();
  expect(await writer.begin(start)).toBeNull();
  expect(await other.begin(start)).toMatchObject({ id: 1, state: "pending" });
});

test("keeps aborted history and requires the exact retained receipt and deployment for rollback", async () => {
  const { writer, reader } = openJournals();
  const initial = { ...request(null), firstCutover: true };
  await writer.begin(initial);
  expect(await reader.abortAfterProviderProof(1)).toMatchObject({
    id: 1,
    state: "aborted",
  });
  expect(await writer.begin(initial)).toBeNull();
  expect(
    await writer.begin({ ...initial, operationKey: randomUUID() }),
  ).toMatchObject({ id: 2 });
  await reader.confirmAfterProviderProof(2, deploymentId);

  const changed = { ...receipt, portfolioSha: "e".repeat(40) };
  expect(await writer.begin({ ...request(2), receipt: changed })).toMatchObject(
    { id: 3, previousId: 2 },
  );
  expect(await reader.readActive()).toMatchObject({ id: 2 });
  expect(await writer.abortAfterProviderProof(2)).toBeNull();
  await reader.confirmAfterProviderProof(3, nextDeploymentId);
  expect(await writer.begin(request(2))).toBeNull();

  const rollback = {
    expectedActiveId: 3,
    operationKey: randomUUID(),
    kind: "rollback" as const,
    rollbackApproval: { knownGoodId: 2, reference: "approval-'42'" },
    receipt,
  };
  expect(await writer.begin({ ...rollback, receipt: changed })).toBeNull();
  expect(
    await writer.begin({
      ...rollback,
      rollbackApproval: { ...rollback.rollbackApproval, knownGoodId: 1 },
    }),
  ).toBeNull();
  expect(await writer.begin(rollback)).toMatchObject({
    id: 4,
    previousId: 3,
    receipt,
    rollbackApproval: rollback.rollbackApproval,
  });
  expect(
    await writer.confirmAfterProviderProof(4, nextDeploymentId),
  ).toBeNull();
  expect(await reader.readPending()).toMatchObject({ id: 4 });
  expect(await reader.confirmAfterProviderProof(4, deploymentId)).toMatchObject(
    { id: 4, state: "confirmed" },
  );
  expect(await writer.readActive()).toMatchObject({
    id: 4,
    deploymentId,
    receipt,
  });
  expect(await writer.readKnownGood(3)).toMatchObject({
    id: 3,
    receipt: changed,
  });
});

test("validates the exact Notes proof and rejects malformed stored records", async () => {
  const { first, writer } = openJournals();
  const start = { ...request(null), firstCutover: true };
  await expect(
    writer.begin({
      ...start,
      notesProof: { ...proof, sha: receipt.portfolioSha },
    }),
  ).rejects.toThrow("Invalid release journal input");
  await expect(
    writer.begin({ ...start, notesProof: { ...proof, runAttempt: 0 } }),
  ).rejects.toThrow("Invalid release journal input");
  await writer.begin(start);
  first.exec(
    `UPDATE release_operations SET proof = '{"conclusion":"success"}'`,
  );
  await expect(writer.readPending()).rejects.toThrow(
    "Release journal query failed",
  );
});

test("fixes the D1 endpoint and refuses redirects", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      success: true,
      errors: [],
      result: [{ success: true, results: [] }],
    }),
  );
  expect(await createReleaseJournal(config, http).readActive()).toBeNull();
  const [url, options] = http.mock.calls[0];
  expect(url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
  );
  expect(options).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + config.token,
    },
    signal: expect.any(AbortSignal),
  });
  expect(JSON.parse(String(options?.body))).toMatchObject({
    params: [expect.stringContaining(config.origin)],
  });
  expect(() =>
    createReleaseJournal({ ...config, origin: config.origin + "/" }, http),
  ).toThrow("Invalid release journal configuration");
  expect(() =>
    createReleaseJournal({ ...config, databaseId: "../query" }, http),
  ).toThrow("Invalid release journal configuration");
  expect(http).toHaveBeenCalledTimes(1);
});

test("sanitizes malformed envelopes, HTTP failures, oversized replies and transport errors", async () => {
  const http = vi.fn<typeof fetch>();
  const journal = createReleaseJournal(config, http);
  for (const response of [
    Response.json({ success: false, errors: [{ message: config.token }] }),
    Response.json({
      success: true,
      errors: [],
      result: [{ success: false, results: [] }],
    }),
    Response.json({
      success: true,
      errors: [],
      result: [{ success: true, results: [{ id: 1 }] }],
    }),
    Response.json({ success: true, errors: [], result: [] }),
    new Response(config.token, { status: 503 }),
    new Response("x".repeat(65_537)),
  ]) {
    http.mockResolvedValueOnce(response);
    await expect(journal.readActive()).rejects.toEqual(
      new Error("Release journal query failed"),
    );
  }
  http.mockRejectedValueOnce(new Error(config.token));
  await expect(journal.readActive()).rejects.toEqual(
    new Error("Release journal query failed"),
  );
});

test("bounds a stalled fetch and a stalled response body", async () => {
  vi.useFakeTimers();
  const http = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(new Response(new ReadableStream()));
  const journal = createReleaseJournal(config, http);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = expect(journal.readPending()).rejects.toEqual(
      new Error("Release journal query failed"),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(http.mock.calls[attempt][1]?.signal?.aborted).toBe(true);
  }
});

test("round-trips an exact paired proof through the private release journal", async () => {
  const { writer, reader } = openJournals();
  const practice = {
    pagesSha256: "a".repeat(64),
    workerSha256: "b".repeat(64),
    workerFiles: 1,
  };
  const paired = { ...receipt, practice };
  const pending = await writer.begin({
    ...request(null),
    firstCutover: true,
    receipt: paired,
  });
  expect(pending?.receipt).toEqual(paired);
  expect((await reader.readPending())?.receipt).toEqual(paired);
  expect(
    (await writer.confirmAfterProviderProof(1, deploymentId))?.receipt,
  ).toEqual(paired);
  expect((await reader.readActive())?.receipt).toEqual(paired);
});
