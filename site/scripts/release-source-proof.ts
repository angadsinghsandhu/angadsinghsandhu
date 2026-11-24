import { z } from "zod";
import type { EligibilityEvidence } from "./release-policy";

type Source = NonNullable<EligibilityEvidence["approval"]>;
type ProtectedSource = Pick<Source, "repository" | "ref">;
type GitHubReader = { token: string; http?: typeof fetch };

const id = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{40}(?![\s\S])/u);
const repoName = z.string().regex(/^[\w-][\w.-]*\/[\w-][\w.-]*(?![\s\S])/u);
const branchPrefix = "refs/heads/";
const branchRef = z.string().refine((ref) => {
  if (!ref.startsWith(branchPrefix)) return false;
  const branch = ref.slice(branchPrefix.length);
  return (
    !/[\s\p{Cc}\p{Cs}~^:?*\[\\]|\.\.|@\{/u.test(branch) &&
    !branch.endsWith(".") &&
    branch
      .split("/")
      .every(
        (part) =>
          part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
      )
  );
});
const sourceSchema = z.object({
  repository: z.object({ id, name: repoName }),
  ref: branchRef,
});
const approvalSchema = sourceSchema.extend({
  workflowId: id,
  jobName: z.string().refine((name) => name.trim().length > 0),
});
const candidateSchema = z.object({
  repository: repoName,
  ref: branchRef,
  sha,
  runId: id,
});
const githubRepository = z.object({ id, full_name: repoName });
const githubCheck = {
  head_sha: sha,
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
};
const githubRun = z.object({
  ...githubCheck,
  id,
  run_attempt: id,
  workflow_id: id,
  repository: githubRepository,
  head_repository: githubRepository,
  head_branch: z.string(),
  event: z.string(),
});
const githubJob = z.object({
  ...githubCheck,
  name: z.string().min(1),
  run_id: id,
  run_attempt: id,
});
const githubJobs = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(githubJob).max(100),
});

function matchesRepository(
  actual: z.infer<typeof githubRepository>,
  expected: Source["repository"],
): boolean {
  return actual.id === expected.id && actual.full_name === expected.name;
}

async function readGitHub<T>(
  path: string,
  { token, http = fetch }: GitHubReader,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  if (typeof token !== "string" || token.length === 0 || /\s/u.test(token)) {
    return undefined;
  }

  try {
    const response = await http("https://api.github.com" + path, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
      },
    });
    if (!response.ok || response.headers.has("link")) return undefined;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function readProtectedHead(
  source: ProtectedSource,
  api: GitHubReader,
): Promise<EligibilityEvidence["head"]> {
  const parsed = sourceSchema.safeParse(source);
  if (!parsed.success) return undefined;

  const { repository, ref } = parsed.data;
  const path = "/repos/" + repository.name;
  const actual = await readGitHub(path, api, githubRepository);
  if (!actual || !matchesRepository(actual, repository)) return undefined;

  const branch = ref.slice(branchPrefix.length);
  const head = await readGitHub(
    path + "/branches/" + encodeURIComponent(branch),
    api,
    z.object({
      name: z.literal(branch),
      protected: z.literal(true),
      commit: z.object({ sha }),
    }),
  );
  if (!head) return undefined;

  return { repository, ref, sha: head.commit.sha, protected: head.protected };
}

export async function readNotesEvidence(
  dispatch: unknown,
  approved: Source,
  api: GitHubReader,
): Promise<EligibilityEvidence> {
  const parsed = candidateSchema.safeParse(dispatch);
  const policy = approvalSchema.safeParse(approved);
  if (!parsed.success || !policy.success) return {};

  const candidate = parsed.data;
  const approval = policy.data;
  if (
    candidate.repository !== approval.repository.name ||
    candidate.ref !== approval.ref
  ) {
    return {};
  }

  const head = await readProtectedHead(approval, api);
  if (!head || head.sha !== candidate.sha) return { approval, head };

  const path =
    "/repos/" + approval.repository.name + "/actions/runs/" + candidate.runId;
  const actual = await readGitHub(path, api, githubRun);
  if (
    !actual ||
    actual.id !== candidate.runId ||
    actual.workflow_id !== approval.workflowId ||
    !matchesRepository(actual.repository, approval.repository) ||
    !matchesRepository(actual.head_repository, approval.repository) ||
    branchPrefix + actual.head_branch !== approval.ref ||
    actual.head_sha !== candidate.sha ||
    actual.event !== "push" ||
    actual.status !== "completed" ||
    actual.conclusion !== "success"
  ) {
    return { approval, head };
  }

  const run = {
    id: actual.id,
    attempt: actual.run_attempt,
    workflowId: actual.workflow_id,
    repository: approval.repository,
    headRepository: approval.repository,
    ref: approval.ref,
    sha: actual.head_sha,
    event: actual.event,
    status: actual.status,
    conclusion: actual.conclusion,
  };

  // A partial job list cannot establish uniqueness of the required job.
  const result = await readGitHub(
    path + "/attempts/" + run.attempt + "/jobs?per_page=100",
    api,
    githubJobs,
  );
  if (
    !result ||
    result.total_count !== result.jobs.length ||
    result.jobs.some(
      (job) => job.run_id !== run.id || job.run_attempt !== run.attempt,
    )
  ) {
    return { approval, head, run };
  }

  const required = result.jobs.filter((job) => job.name === approval.jobName);
  if (required.length !== 1) return { approval, head, run };

  const [job] = required;
  return {
    approval,
    head,
    run,
    job: {
      name: job.name,
      runId: job.run_id,
      runAttempt: job.run_attempt,
      sha: job.head_sha,
      status: job.status,
      conclusion: job.conclusion,
    },
  };
}
