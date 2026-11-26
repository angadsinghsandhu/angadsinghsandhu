import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { outputOrigin } from "./notes-redirects.ts";
import { evaluateNotesRevision } from "./release-policy.ts";
import {
  readCurrentNotesRevision,
  readNotesEvidence,
  readProtectedHead,
} from "./release-source-proof.ts";

export const portfolio = {
  repository: { id: 339077137, name: "angadsinghsandhu/angadsinghsandhu" },
  ref: "refs/heads/main",
};
export const notesRepository = {
  id: 590347468,
  name: "angadsinghsandhu/Notes",
};
export const workflowRef =
  portfolio.repository.name +
  "/.github/workflows/portfolio-release.yml@" +
  portfolio.ref;
export const notesWorkflowId = 379127533;
export const notesJobName = "verify";
const sha = z.string().regex(/^[0-9a-f]{40}(?![\s\S])/u);
const id = z.number().int().positive();
const envelope = z.object({
  repository: z.object({
    id: z.literal(portfolio.repository.id),
    full_name: z.literal(portfolio.repository.name),
  }),
});
const push = envelope.extend({
  ref: z.literal(portfolio.ref),
  after: sha,
  deleted: z.literal(false),
});
const dispatch = envelope.extend({
  action: z.literal("portfolio-notes-verified"),
  sender: z.object({ id }),
  client_payload: z.object({
    repository: z.literal(notesRepository.name),
    ref: z.string(),
    sha,
    runId: id,
  }),
});

type GitHubContext = {
  eventName?: string;
  ref?: string;
  sha?: string;
  workflowRef?: string;
  workflowSha?: string;
};

type CandidateConfig = {
  notesRef?: string;
  notesSenderId?: string;
  origin?: string;
};

export async function selectReleaseCandidate(
  event: unknown,
  context: GitHubContext,
  config: CandidateConfig,
  api: Parameters<typeof readProtectedHead>[1],
) {
  const commit = sha.parse(context.sha);
  if (
    context.ref !== portfolio.ref ||
    context.workflowRef !== workflowRef ||
    context.workflowSha !== commit
  ) {
    throw new Error(
      "Release candidate requires the exact Portfolio main workflow revision",
    );
  }

  const origin = outputOrigin(config.origin);
  const { notesRef } = config;
  if (!notesRef) throw new Error("Configure the approved Notes ref");
  const approval = {
    repository: notesRepository,
    ref: notesRef,
    workflowId: notesWorkflowId,
    jobName: notesJobName,
  };

  let dispatched;
  if (context.eventName === "push") {
    const payload = push.parse(event);
    if (payload.after !== commit)
      throw new Error("Portfolio push does not match the workflow revision");
  } else if (context.eventName === "repository_dispatch") {
    const payload = dispatch.parse(event);
    if (config.notesSenderId !== String(payload.sender.id))
      throw new Error("Notes dispatch sender is outside the approved policy");
    if (payload.client_payload.ref !== notesRef)
      throw new Error("Notes dispatch ref is outside the approved policy");
    dispatched = payload.client_payload;
  } else {
    throw new Error("Unsupported release candidate event");
  }

  const head = await readProtectedHead(portfolio, api);
  if (head?.sha !== commit)
    throw new Error("Portfolio workflow is outside the current protected head");

  const selection = dispatched
    ? {
        candidate: dispatched,
        evidence: await readNotesEvidence(dispatched, approval, api),
      }
    : await readCurrentNotesRevision(approval, api);

  const run = selection?.evidence.run;
  if (
    !selection ||
    !run ||
    evaluateNotesRevision(selection.candidate, selection.evidence).decision !==
      "eligible"
  ) {
    throw new Error("Unable to prove current Notes verification");
  }

  return {
    portfolio_sha: commit,
    notes_sha: selection.candidate.sha,
    notes_run_id: run.id,
    notes_run_attempt: run.attempt,
    origin,
  };
}

if (import.meta.main) {
  try {
    const env = process.env;
    if (!env.GITHUB_EVENT_PATH || !env.GITHUB_OUTPUT)
      throw new Error("Run candidate selection inside GitHub Actions");
    const event: unknown = JSON.parse(
      await readFile(env.GITHUB_EVENT_PATH, "utf8"),
    );
    const candidate = await selectReleaseCandidate(
      event,
      {
        eventName: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
        sha: env.GITHUB_SHA,
        workflowRef: env.GITHUB_WORKFLOW_REF,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
      },
      {
        notesRef: env.PORTFOLIO_RELEASE_NOTES_REF,
        notesSenderId: env.PORTFOLIO_RELEASE_NOTES_SENDER_ID,
        origin: env.PORTFOLIO_ORIGIN,
      },
      { token: env.PORTFOLIO_RELEASE_SOURCE_TOKEN ?? "" },
    );
    await appendFile(
      env.GITHUB_OUTPUT,
      Object.entries(candidate)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
