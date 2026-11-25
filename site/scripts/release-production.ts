import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { outputOrigin } from "./notes-redirects.ts";
import { releaseArtifactIdentity } from "./release-artifact-download.ts";
import {
  notesJobName,
  notesRepository,
  notesWorkflowId,
  portfolio,
  workflowRef,
} from "./release-candidate.ts";
import {
  coordinateRelease,
  type ReleaseCoordinatorRequest,
} from "./release-coordinator.ts";
import { createReleaseJournal } from "./release-journal.ts";
import { createReleasePages } from "./release-pages.ts";
import { createReleaseSmoke } from "./release-smoke.ts";
import { readGitHub, readProtectedHead } from "./release-source-proof.ts";
import { createReleaseStage } from "./stage-release-candidate.ts";

const operatorWorkflowRef =
  portfolio.repository.name +
  "/.github/workflows/portfolio-rollback.yml@" +
  portfolio.ref;
const sha = releaseArtifactIdentity.shape.portfolioSha;
const id = releaseArtifactIdentity.shape.runId;
const environmentId = z
  .string()
  .regex(/^[1-9][0-9]*(?![\s\S])/u)
  .transform(Number)
  .pipe(id);
const receiptSchema = releaseArtifactIdentity
  .extend({
    notesSha: sha,
    snapshotSchema: id,
    manifestSha256: releaseArtifactIdentity.shape.archiveSha256,
  })
  .strict();
const repositoryIdentity = z.object({
  id: z.literal(portfolio.repository.id),
  full_name: z.literal(portfolio.repository.name),
  default_branch: z.literal("main"),
});
const repositoryEvent = z.object({ repository: repositoryIdentity });
const sender = z.object({ id });
const push = repositoryEvent.extend({
  ref: z.literal(portfolio.ref),
  after: sha,
  deleted: z.literal(false),
});
const notesDispatch = repositoryEvent.extend({
  action: z.literal("portfolio-notes-verified"),
  sender,
  client_payload: z.object({
    repository: z.literal(notesRepository.name),
    ref: z.string(),
    sha,
    runId: id,
  }),
});
const operatorDispatch = repositoryEvent.extend({
  sender,
  inputs: z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("rollback"),
      expected_active_id: environmentId,
      known_good_id: environmentId,
      reference: z
        .string()
        .max(256)
        .refine((value) => value.trim().length > 0 && !/[\p{Cc}]/u.test(value)),
    }),
    z.strictObject({
      operation: z.literal("recover"),
      expected_active_id: z.literal("").optional(),
      known_good_id: z.literal("").optional(),
      reference: z.literal("").optional(),
    }),
  ]),
});
const notesBranch = z
  .string()
  .max(256)
  .regex(/^refs\/heads\/[^\s\p{Cc}]+(?![\s\S])/u);

function required(value: string | undefined): string {
  if (!value) throw new Error("Missing production configuration");
  return value;
}

function releaseRequest(
  env: NodeJS.ProcessEnv,
  event: unknown,
  commit: string,
  origin: string,
  notesRef: string,
  runId: number,
  runAttempt: number,
): ReleaseCoordinatorRequest {
  if (
    env.PORTFOLIO_PRODUCTION_ENABLED !== "true" ||
    env.GITHUB_WORKFLOW_REF !== workflowRef ||
    env.PORTFOLIO_SELECTED_SHA !== commit ||
    env.PORTFOLIO_SELECTED_ORIGIN !== origin
  )
    throw new Error(
      "Release job is outside approved publication configuration",
    );

  const receipt = receiptSchema.parse(
    JSON.parse(required(env.PORTFOLIO_SELECTED_RECEIPT)),
  );
  const notesRunId = environmentId.parse(env.PORTFOLIO_SELECTED_NOTES_RUN_ID);
  const notesRunAttempt = environmentId.parse(
    env.PORTFOLIO_SELECTED_NOTES_RUN_ATTEMPT,
  );
  if (
    receipt.portfolioSha !== commit ||
    receipt.notesSha !== env.PORTFOLIO_SELECTED_NOTES_SHA ||
    receipt.runId !== runId ||
    receipt.runAttempt !== runAttempt
  )
    throw new Error(
      "Release receipt does not match the verified build in this run",
    );

  if (env.GITHUB_EVENT_NAME === "push") {
    if (push.parse(event).after !== commit)
      throw new Error("Push does not match the protected workflow revision");
  } else if (env.GITHUB_EVENT_NAME === "repository_dispatch") {
    const payload = notesDispatch.parse(event);
    if (
      env.PORTFOLIO_RELEASE_NOTES_SENDER_ID !== String(payload.sender.id) ||
      payload.client_payload.ref !== notesRef ||
      payload.client_payload.sha !== receipt.notesSha ||
      payload.client_payload.runId !== notesRunId
    )
      throw new Error("Notes dispatch does not match the approved selection");
  } else {
    throw new Error("Unsupported publication event");
  }

  return {
    kind: "release",
    verified: {
      receipt,
      notesRunAttempt,
      notesCandidate: {
        repository: notesRepository.name,
        ref: notesRef,
        sha: receipt.notesSha,
        runId: notesRunId,
      },
    },
  };
}

export function productionInput(env: NodeJS.ProcessEnv, event: unknown) {
  const commit = sha.parse(env.GITHUB_SHA);
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_WORKFLOW_SHA !== commit ||
    env.GITHUB_REPOSITORY !== portfolio.repository.name ||
    env.GITHUB_REF !== portfolio.ref ||
    env.GITHUB_REF_PROTECTED !== "true"
  )
    throw new Error(
      "Production requires the exact protected Portfolio main workflow revision",
    );

  const origin = outputOrigin(env.PORTFOLIO_PRODUCTION_ORIGIN);
  if (origin !== env.PORTFOLIO_PRODUCTION_ORIGIN)
    throw new Error(
      "Production origin must be the exact approved HTTPS origin",
    );
  const runId = environmentId.parse(env.GITHUB_RUN_ID);
  const runAttempt = environmentId.parse(env.GITHUB_RUN_ATTEMPT);
  const isOperator = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const notesRef = isOperator
    ? ""
    : notesBranch.parse(env.PORTFOLIO_RELEASE_NOTES_REF);
  const legacyPath = env.PORTFOLIO_PRODUCTION_LEGACY_PATH ?? "";
  const legacyTarget = env.PORTFOLIO_PRODUCTION_LEGACY_TARGET ?? "";
  if (Boolean(legacyPath) !== Boolean(legacyTarget))
    throw new Error("Configure both endpoints of the approved legacy mapping");
  const smoke = createReleaseSmoke(
    origin,
    legacyPath ? { path: legacyPath, target: legacyTarget } : undefined,
  );

  let request: ReleaseCoordinatorRequest;
  if (isOperator) {
    const payload = operatorDispatch.parse(event);
    if (
      env.PORTFOLIO_PRODUCTION_OPERATIONS_ENABLED !== "true" ||
      env.GITHUB_WORKFLOW_REF !== operatorWorkflowRef ||
      runAttempt !== 1 ||
      env.GITHUB_ACTOR_ID !== String(payload.sender.id) ||
      env.PORTFOLIO_PRODUCTION_OPERATOR_ID !== String(payload.sender.id)
    )
      throw new Error(
        "Production operation requires an approved first-attempt operator dispatch",
      );
    const { inputs } = payload;
    request =
      inputs.operation === "recover"
        ? { kind: "recover" }
        : {
            kind: "rollback",
            expectedActiveId: inputs.expected_active_id,
            knownGoodId: inputs.known_good_id,
            reference: inputs.reference,
          };
  } else {
    request = releaseRequest(
      env,
      event,
      commit,
      origin,
      notesRef,
      runId,
      runAttempt,
    );
  }
  return { commit, origin, notesRef, request, smoke };
}

export async function runProductionRelease(
  env: NodeJS.ProcessEnv,
  event: unknown,
  { coordinate = coordinateRelease, sourceHttp = fetch } = {},
) {
  const { commit, origin, notesRef, request, smoke } = productionInput(
    env,
    event,
  );
  const sourceApi = {
    token: required(env.PORTFOLIO_RELEASE_SOURCE_TOKEN),
    http: sourceHttp,
  };
  const [repository, head] = await Promise.all([
    readGitHub(
      "/repos/" + portfolio.repository.name,
      sourceApi,
      repositoryIdentity,
    ),
    readProtectedHead(portfolio, sourceApi),
  ]);
  if (!repository || head?.sha !== commit)
    throw new Error(
      "Production workflow is outside the current protected default head",
    );

  const accountId = required(env.PORTFOLIO_PRODUCTION_ACCOUNT_ID);
  const project = required(env.PORTFOLIO_PRODUCTION_PROJECT);
  const journal = createReleaseJournal({
    accountId,
    project,
    origin,
    databaseId: required(env.PORTFOLIO_PRODUCTION_DATABASE_ID),
    token: required(env.PORTFOLIO_PRODUCTION_JOURNAL_TOKEN),
  });
  const pages = createReleasePages({
    accountId,
    projectName: project,
    productionBranch: "main",
    origin,
    token: required(env.PORTFOLIO_PRODUCTION_PAGES_TOKEN),
  });
  const withStage =
    request.kind === "release"
      ? createReleaseStage({
          api: { token: required(env.PORTFOLIO_PRODUCTION_ARTIFACT_TOKEN) },
          scratchParent: required(env.RUNNER_TEMP),
          executable: fileURLToPath(
            new URL("../node_modules/.bin/wrangler", import.meta.url),
          ),
          pythonExecutable: required(env.PORTFOLIO_PRODUCTION_PYTHON),
          origin,
        })
      : async () => {
          throw new Error("Operator operations cannot stage a candidate");
        };

  const outcome = await coordinate(request, {
    approval: {
      portfolio,
      notes: {
        repository: notesRepository,
        ref: notesRef,
        workflowId: notesWorkflowId,
        jobName: notesJobName,
      },
    },
    sourceApi,
    // GitHub assigns this job only while it holds the shared production queue.
    serialized: (operation) => operation(),
    origin,
    journal,
    pages,
    withStage,
    smoke,
    firstCutover:
      request.kind === "release" &&
      env.PORTFOLIO_PRODUCTION_FIRST_CUTOVER === "true",
    automaticRestore:
      request.kind === "release" &&
      env.PORTFOLIO_PRODUCTION_AUTOMATIC_RESTORE === "true",
  });

  const exitCode =
    outcome.decision === "confirmed" ||
    outcome.decision === "noop" ||
    (request.kind === "recover" && outcome.decision === "recovered")
      ? 0
      : 1;
  return { ...outcome, exitCode };
}

if (import.meta.main) {
  const env = process.env;
  try {
    const event: unknown = JSON.parse(
      await readFile(required(env.GITHUB_EVENT_PATH), "utf8"),
    );
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check") {
      productionInput(env, event);
    } else if (args.length === 0) {
      const outcome = await runProductionRelease(env, event);
      console.log(
        JSON.stringify({
          decision: outcome.decision,
          operationId:
            "operationId" in outcome ? outcome.operationId : undefined,
        }),
      );
      process.exitCode = outcome.exitCode;
    } else {
      throw new Error("Unsupported production command");
    }
  } catch {
    // Credentials, payloads and remote diagnostics stay out of workflow logs.
    console.error("Production release could not be verified or completed");
    process.exitCode = 1;
  }
}
