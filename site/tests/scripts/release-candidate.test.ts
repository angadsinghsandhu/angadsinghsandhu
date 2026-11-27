import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { selectReleaseCandidate } from "../../scripts/release-candidate.ts";

const portfolioSha = "a".repeat(40);
const notesSha = "b".repeat(40);
const portfolioRepo = {
  id: 339077137,
  full_name: "angadsinghsandhu/angadsinghsandhu",
};
const notesRepo = { id: 590347468, full_name: "angadsinghsandhu/Notes" };
const notesRef = "refs/heads/release/notes";
const notesRun = {
  id: 45294310968,
  run_attempt: 2,
  workflow_id: 379127533,
  repository: notesRepo,
  head_repository: notesRepo,
  head_branch: "release/notes",
  head_sha: notesSha,
  event: "push",
  status: "completed",
  conclusion: "success",
};
const jobs = {
  total_count: 1,
  jobs: [
    {
      name: "verify",
      run_id: notesRun.id,
      run_attempt: notesRun.run_attempt,
      head_sha: notesSha,
      status: "completed",
      conclusion: "success",
    },
  ],
};
const context = {
  eventName: "push",
  ref: "refs/heads/main",
  workflowRef:
    portfolioRepo.full_name +
    "/.github/workflows/portfolio-release.yml@refs/heads/main",
  sha: portfolioSha,
  workflowSha: portfolioSha,
};
const config = {
  notesRef,
  notesSenderId: "12345",
  origin: "https://portfolio.example/",
};
const push = {
  repository: portfolioRepo,
  ref: context.ref,
  after: portfolioSha,
  deleted: false,
};
const dispatch = {
  repository: portfolioRepo,
  action: "portfolio-notes-verified",
  sender: { id: 12345 },
  client_payload: {
    repository: notesRepo.full_name,
    ref: notesRef,
    sha: notesSha,
    runId: notesRun.id,
  },
};
const expected = {
  portfolio_sha: portfolioSha,
  notes_sha: notesSha,
  notes_run_id: notesRun.id,
  notes_run_attempt: notesRun.run_attempt,
  origin: "https://portfolio.example",
};
const portfolioHead = {
  name: "main",
  protected: true,
  commit: { sha: portfolioSha },
};
const notesHead = {
  name: "release/notes",
  protected: true,
  commit: { sha: notesSha },
};

function fakeGitHub(...payloads: unknown[]) {
  const http = vi.fn<typeof fetch>();
  for (const payload of payloads)
    http.mockResolvedValueOnce(Response.json(payload));
  return { token: "test-token", http };
}

it("selects the current verified Notes revision for the exact protected Portfolio push", async () => {
  const api = fakeGitHub(
    portfolioRepo,
    portfolioHead,
    notesRepo,
    notesHead,
    {
      total_count: 1,
      workflow_runs: [{ ...notesRun, run_number: 5 }],
    },
    notesRepo,
    notesHead,
    notesRun,
    jobs,
  );
  await expect(
    selectReleaseCandidate(push, context, config, api),
  ).resolves.toEqual(expected);
  expect(api.http.mock.calls.map(([url]) => url)).toContain(
    "https://api.github.com/repos/angadsinghsandhu/Notes/actions/workflows/379127533/runs?branch=release%2Fnotes&event=push&head_sha=" +
      notesSha +
      "&status=success&per_page=100",
  );
});

it("binds the allowlisted dispatch to a real Notes run and job attempt", async () => {
  const api = fakeGitHub(
    portfolioRepo,
    portfolioHead,
    notesRepo,
    notesHead,
    notesRun,
    jobs,
  );
  await expect(
    selectReleaseCandidate(
      dispatch,
      { ...context, eventName: "repository_dispatch" },
      config,
      api,
    ),
  ).resolves.toEqual(expected);
  expect(api.http.mock.calls.at(-1)?.[0]).toBe(
    "https://api.github.com/repos/angadsinghsandhu/Notes/actions/runs/45294310968/attempts/2/jobs?per_page=100",
  );
});

it.each([
  ["PR", push, { ...context, eventName: "pull_request" }, config],
  ["push after", { ...push, after: notesSha }, context, config],
  ["push deletion", { ...push, deleted: true }, context, config],
  ["push ref", { ...push, ref: "refs/heads/dev" }, context, config],
  [
    "repository ID",
    { ...push, repository: { ...portfolioRepo, id: 1 } },
    context,
    config,
  ],
  [
    "workflow ref",
    push,
    { ...context, workflowRef: context.workflowRef + "-other" },
    config,
  ],
  ["workflow SHA", push, { ...context, workflowSha: notesSha }, config],
  ["Notes ref missing", push, context, { ...config, notesRef: undefined }],
  ["origin missing", push, context, { ...config, origin: undefined }],
  [
    "dispatch sender",
    { ...dispatch, sender: { id: 12346 } },
    { ...context, eventName: "repository_dispatch" },
    config,
  ],
  [
    "dispatch type",
    { ...dispatch, action: "wrong" },
    { ...context, eventName: "repository_dispatch" },
    config,
  ],
  [
    "sender missing",
    dispatch,
    { ...context, eventName: "repository_dispatch" },
    { ...config, notesSenderId: undefined },
  ],
] as const)(
  "denies %s before API access",
  async (_why, event, source, settings) => {
    const api = fakeGitHub();
    await expect(
      selectReleaseCandidate(event, source, settings, api),
    ).rejects.toThrow();
    expect(api.http).not.toHaveBeenCalled();
  },
);

it("denies a superseded Portfolio SHA before looking up Notes", async () => {
  const api = fakeGitHub(portfolioRepo, {
    ...portfolioHead,
    commit: { sha: notesSha },
  });
  await expect(
    selectReleaseCandidate(push, context, config, api),
  ).rejects.toThrow();
  expect(api.http).toHaveBeenCalledTimes(2);
});

it("rejects a successful run whose required Notes job failed", async () => {
  const api = fakeGitHub(
    portfolioRepo,
    portfolioHead,
    notesRepo,
    notesHead,
    notesRun,
    {
      ...jobs,
      jobs: [{ ...jobs.jobs[0], conclusion: "failure" }],
    },
  );
  await expect(
    selectReleaseCandidate(
      dispatch,
      { ...context, eventName: "repository_dispatch" },
      config,
      api,
    ),
  ).rejects.toThrow();
});

const workflow = readFileSync(
  new URL("../../../.github/workflows/portfolio-release.yml", import.meta.url),
  "utf8",
);

it.each(["true", "TRUE", "", "false", "true "])(
  "allows protected source selection only for the exact flag (received %j)",
  (flag) => {
    const activation = workflow.match(
      /id: activation\n((?: {8,}[^\n]*\n)*?) {8}run: \|\n((?: {10}[^\n]*\n)+)/,
    );
    expect(activation).toBeDefined();
    const [, settings, guard] = activation!;
    const workingDirectory =
      settings?.match(/working-directory: (\S+)/)?.[1] ??
      workflow.match(
        /defaults:\n {6}run:\n {8}working-directory: (\S+)/,
      )?.[1] ??
      ".";
    const directory = mkdtempSync(
      join(tmpdir(), "portfolio-release-activation-"),
    );
    const output = join(directory, "outputs");
    try {
      const result = spawnSync("bash", ["-e", "-c", guard!], {
        cwd: join(directory, workingDirectory),
        env: { RELEASE_CANDIDATE_FLAG: flag, GITHUB_OUTPUT: output },
      });
      expect(result.status).toBe(0);
      if (flag === "true")
        expect(readFileSync(output, "utf8")).toBe("enabled=true\n");
      else expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("keeps checkout, bootstrap and the source token behind the exact flag guard", () => {
  const selection = workflow.slice(
    workflow.indexOf("  select:"),
    workflow.indexOf("  build:"),
  );
  expect(
    selection.match(/if: steps.activation.outputs.enabled == 'true'/g),
  ).toHaveLength(4);
  expect(workflow).toContain("if: needs.select.outputs.portfolio_sha != ''");
});

it("gates the artifact on source selection and every verification step", () => {
  expect(workflow).toMatch(
    /vars\.PORTFOLIO_RELEASE_CANDIDATE_ENABLED == 'true'/,
  );
  expect(workflow).toContain("needs: select");
  expect(workflow).toMatch(
    /npm run verify\n[\s\S]*scripts\/export-portfolio\.ts[\s\S]*npm run import:notes[\s\S]*npm run build:release[\s\S]*npm run verify:output[\s\S]*npm run test:browser[\s\S]*uses: actions\/upload-artifact@/,
  );
  const upload = workflow.slice(
    workflow.indexOf("uses: actions/upload-artifact@"),
  );
  expect(workflow).toContain("echo 'artifact_path=site/dist'");
  expect(workflow).toContain("artifact_path=%s\\npractice_bundle=%s");
  expect(upload).toContain("path: ${{ steps.verify.outputs.artifact_path }}\n");
  expect(upload).toContain("if-no-files-found: error\n");
  expect(upload).not.toMatch(/always\(\)|continue-on-error|overwrite: true/);
  expect(workflow).not.toMatch(
    /pull_request|wrangler|CLOUDFLARE|id-token: write/,
  );
});
