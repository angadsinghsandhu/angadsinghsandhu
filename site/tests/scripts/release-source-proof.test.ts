import { expect, it, vi } from "vitest";
import { evaluateNotesRevision } from "../../scripts/release-policy";
import {
  readNotesEvidence,
  readProtectedHead,
} from "../../scripts/release-source-proof";

const sha = "a".repeat(40);
const branch = "release/notes";
const ref = "refs/heads/" + branch;
const repository = { id: 590347468, name: "example/notes" };
const source = { repository, ref };
const approval = { ...source, workflowId: 379127533, jobName: "verify" };
const candidate = {
  repository: repository.name,
  ref,
  sha,
  runId: 45294310968,
};
const githubRepository = { id: repository.id, full_name: repository.name };
const githubBranch = { name: branch, protected: true, commit: { sha } };
const githubRun = {
  id: candidate.runId,
  run_attempt: 2,
  workflow_id: approval.workflowId,
  repository: githubRepository,
  head_repository: githubRepository,
  head_branch: branch,
  head_sha: sha,
  event: "push",
  status: "completed",
  conclusion: "success",
};
const githubJob = {
  name: approval.jobName,
  run_id: candidate.runId,
  run_attempt: 2,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
};

function fakeGitHub(...payloads: unknown[]) {
  const http = vi.fn<typeof fetch>();
  for (const payload of payloads) {
    http.mockResolvedValueOnce(
      payload instanceof Response ? payload : Response.json(payload),
    );
  }
  return { token: "test-token", http };
}

it("reads the protected head and exact Notes attempt from the fixed API", async () => {
  const api = fakeGitHub(githubRepository, githubBranch, githubRun, {
    total_count: 2,
    jobs: [githubJob, { ...githubJob, name: "other" }],
  });
  const evidence = await readNotesEvidence(candidate, approval, api);
  expect(evidence).toEqual({
    approval,
    head: { ...source, sha, protected: true },
    run: {
      ...source,
      id: candidate.runId,
      attempt: 2,
      workflowId: approval.workflowId,
      headRepository: repository,
      event: "push",
      sha,
      status: "completed",
      conclusion: "success",
    },
    job: {
      name: approval.jobName,
      runId: candidate.runId,
      runAttempt: 2,
      sha,
      status: "completed",
      conclusion: "success",
    },
  });
  expect(evaluateNotesRevision(candidate, evidence)).toEqual({
    decision: "eligible",
  });
  const base = "https://api.github.com/repos/example/notes";
  expect(api.http.mock.calls.map(([url]) => url)).toEqual([
    base,
    base + "/branches/release%2Fnotes",
    base + "/actions/runs/45294310968",
    base + "/actions/runs/45294310968/attempts/2/jobs?per_page=100",
  ]);
  for (const [, request] of api.http.mock.calls) {
    expect(request).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
  }
});

it.each([
  { repository: "unknown/notes" },
  { ref: "refs/heads/other" },
  { runId: "45294310968" },
  { runId: Number.MAX_SAFE_INTEGER + 1 },
  { sha: sha + "\n" },
  { sha: [sha] },
])("denies untrusted dispatch fields before HTTP (%j)", async (change) => {
  const api = fakeGitHub();
  expect(
    await readNotesEvidence({ ...candidate, ...change }, approval, api),
  ).toEqual({});
  expect(api.http).not.toHaveBeenCalled();
});

it.each([
  { ...source, ref: "refs/heads/.." },
  { ...source, ref: "refs/heads/\ud800" },
  { ...source, repository: { ...repository, name: "../notes" } },
])("denies unsafe approved paths before HTTP (%j)", async (invalidSource) => {
  const api = fakeGitHub();
  expect(await readProtectedHead(invalidSource, api)).toBeUndefined();
  expect(api.http).not.toHaveBeenCalled();
});

it.each([
  [{ ...githubRepository, id: 42 }, githubBranch],
  [githubRepository, { ...githubBranch, name: "other" }],
  [githubRepository, { ...githubBranch, protected: false }],
  [githubRepository, { ...githubBranch, commit: { sha: [sha] } }],
  [githubRepository, new Response("broken")],
  [githubRepository, new Response("missing", { status: 404 })],
])(
  "denies an unverifiable repository or protected head",
  async (repo, head) => {
    expect(
      await readProtectedHead(source, fakeGitHub(repo, head)),
    ).toBeUndefined();
  },
);

it.each([
  { id: 42 },
  { run_attempt: -1 },
  { workflow_id: 42 },
  { repository: { ...githubRepository, id: 42 } },
  { head_repository: { ...githubRepository, full_name: "other/notes" } },
  { head_branch: "other" },
  { head_sha: "b".repeat(40) },
  { event: "pull_request" },
  { status: "queued" },
])("denies a mismatched run without looking for jobs (%j)", async (change) => {
  const api = fakeGitHub(githubRepository, githubBranch, {
    ...githubRun,
    ...change,
  });
  const evidence = await readNotesEvidence(candidate, approval, api);
  expect(evaluateNotesRevision(candidate, evidence).decision).toBe("deny");
  expect(api.http).toHaveBeenCalledTimes(3);
});

it.each([
  { total_count: 2, jobs: [githubJob] },
  { total_count: 2, jobs: [githubJob, githubJob] },
  { total_count: 2, jobs: [githubJob, null] },
  { total_count: 0, jobs: [] },
  { total_count: 1, jobs: [{ ...githubJob, run_attempt: 1 }] },
  { total_count: 1, jobs: [{ ...githubJob, conclusion: "failure" }] },
  Response.json(
    { total_count: 1, jobs: [githubJob] },
    {
      headers: { link: '<https://api.github.com/next>; rel="next"' },
    },
  ),
])("denies incomplete, ambiguous or mismatched jobs", async (jobs) => {
  const api = fakeGitHub(githubRepository, githubBranch, githubRun, jobs);
  const evidence = await readNotesEvidence(candidate, approval, api);
  expect(evaluateNotesRevision(candidate, evidence).decision).toBe("deny");
});

it("matches the exact configured job name", async () => {
  const exactApproval = { ...approval, jobName: " verify " };
  const api = fakeGitHub(githubRepository, githubBranch, githubRun, {
    total_count: 1,
    jobs: [githubJob],
  });
  const evidence = await readNotesEvidence(candidate, exactApproval, api);
  expect(evaluateNotesRevision(candidate, evidence).decision).toBe("deny");
});
