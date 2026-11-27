# Certifying a Portfolio release

Use Node 24.18.1 and the locked Portfolio dependencies. Import the production Notes export and its receipt from the verified, reviewed Notes revision. Run the ordinary Portfolio gate before assembling the combined artifact. That gate builds the standalone shell into `dist/`, so run it before the release build.

```sh
cd site
npm run bootstrap
npm run verify

npm run import:notes -- --from "$NOTES_EXPORT" --receipt "$NOTES_RECEIPT" --revision "$NOTES_REVISION"
export PORTFOLIO_ORIGIN="$RELEASE_HTTPS_ORIGIN"
npm run build:release
npm run verify:output -- --dir dist
PORTFOLIO_NOTES_BROWSER=archive npx playwright test
```

The origin must match the approved release hostname. An HTTPS rehearsal origin is suitable for local certification. The release wrapper runs the Astro build, emits the Pagefind index and PDF runtime, copies the bound Notes assets, then writes the sitemap and any validated redirect rules. The verifier reads final `dist/` and the imported snapshot. A preview export and the shell-only build cannot serve as a release artifact.

Keep the verifier output alongside the release evidence. The private Pagefind inventory in `site/.generated/pages-search-inventory.json` accompanies certification and stays outside the upload. The verifier output records the Notes revision and manifest digest, route differences, fragment and search counts, and the largest files. Retain the reviewed source identity and import receipt in CI. Keep the manifest, receipts, trace packages and other private material outside the upload directory. Upload only the exact verified artifact after launch authorization.

## Pull request verification

The required `Verify portfolio` job runs for opened, reopened and updated pull requests. It tests GitHub's pull request merge revision. The job then exports Notes from the public checkout pinned in the workflow, builds the combined artifact with `https://portfolio-preview.example`, verifies `dist/` and runs Chromium in archive mode. The pinned revision is an engineering fixture for PR verification. The job uses read-only repository access and writes the export and receipt in runner temporary storage.

## Release candidate workflow

`Portfolio release candidate` starts on pushes to Portfolio `main` and GitHub `repository_dispatch` events of type `portfolio-notes-verified`. The jobs are disabled unless `PORTFOLIO_RELEASE_CANDIDATE_ENABLED` is exactly `true`. Configure these repository settings before a candidate run:

| Setting                             | Value                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORTFOLIO_RELEASE_NOTES_REF`       | The approved protected Notes branch as a full `refs/heads/…` ref.                                                                                                                |
| `PORTFOLIO_RELEASE_NOTES_SENDER_ID` | The approved sender's numeric GitHub account ID, required for dispatch.                                                                                                          |
| `PORTFOLIO_RELEASE_ORIGIN`          | The approved HTTPS origin to embed in the combined build.                                                                                                                        |
| `PORTFOLIO_RELEASE_SOURCE_TOKEN`    | A repository secret with read-only access to repository metadata and branches in Portfolio and Notes and Actions runs and jobs in Notes. Only the source-proof step receives it. |

A dispatch carries `repository`, `ref`, `sha` and numeric `runId` in `client_payload`. Source selection verifies GitHub's sender and target repository, checks that the workflow SHA is the current protected Portfolio `main` commit, and checks Notes workflow `379127533` and its required `verify` job for the same protected Notes commit. A Portfolio push discovers the eligible Notes run for the current approved Notes head. A dispatch supplies the run to check. The chooser records both source SHAs and the Notes run ID and attempt.

The build uses clean, SHA-pinned checkouts. After standalone verification, it exports Notes into runner temporary storage, imports the export and receipt, builds with the approved origin, writes the [release marker](#hosted-release-identity), certifies the output, and runs the Chromium archive suite. A candidate with zero verified lessons uploads only `site/dist`. A candidate with verified lessons uploads the certified sibling `pages/` and `worker-assets/` directories. Both use `portfolio-candidate-<run ID>-<attempt>`. The source-selection and candidate-build jobs have no hosting credentials. The separate publication job runs only after both succeed and the build exposes its validated receipt.

After upload, the build job rereads the validated production snapshot and checks GitHub artifact metadata with the job’s read-only Actions token. The check binds the artifact ID, archive SHA-256, repository, Portfolio revision and exact run-attempt name, and requires a current expiration. On success, the job exposes its separate JSON `release_receipt` output with the Portfolio and Notes SHAs, snapshot schema and manifest digest, run ID and attempt, artifact ID, and archive SHA-256. A failed check leaves the job without a receipt. The receipt stays outside the archive. Paired receipts also carry the certified Pages digest, Worker digest, and trace package count. Receipt creation compares the exact artifact directories to the separate certification proof, and the publisher verifies both tree digests again after extraction.

Production publication also requires the separate controls and host configuration below.

### Hosted release identity

The candidate job writes the public `/portfolio-release.json` into the freshly built `dist/` before output verification. Version 1 binds the canonical HTTPS origin, Portfolio and Notes SHAs, and the candidate build's Actions run ID and attempt in fixed JSON bytes. An existing file at the reserved path fails the build. Standalone and rehearsal builds omit the marker. The candidate passes `--release-marker` to the output verifier, which requires the exact bytes and binds the Notes SHA to the verified import receipt. Ordinary output verification rejects this reserved file.

Before activation, verify the staged marker byte for byte using the selected receipt's source SHAs, build run ID and attempt, and the approved origin. For host confirmation, the probe makes a fresh credential-free GET to that origin with redirects disabled, a ten-second deadline, and a response size bounded by the expected marker bytes. Compare the response with the exact selected and prior markers to distinguish a selected release, a prior release, and an unknown host state. The marker identifies what the host is serving. Provider deployment confirmation and canonical hostname, alias and cache behavior still require cutover verification. Run the [offline marker fixtures](../site/tests/scripts/release-build-marker.test.ts) from `site` with `npx vitest run tests/scripts/release-build-marker.test.ts`.

## Credential-free publication rehearsal

The rehearsal uses GitHub response fixtures, two ZIP archives and a shared activation fixture. Run it from `site` on the pinned Node version.

```sh
npx vitest run tests/scripts/release-publication.test.ts tests/scripts/release-artifact-{download,transport}.test.ts
```

The publication gate reads the current active receipt and rechecks both protected heads after acquiring the shared lock. For a normal release, it also requires the successful Notes run and required job to match the exact attempt in the trusted verified build record. It denies stale pairs and skips active duplicates before archive retrieval. It checks GitHub metadata for the receipt's exact archive ID, run, attempt, repository, Portfolio revision, digest and expiry, then hashes the downloaded archive bytes. After archive validation, it rechecks both protected heads and the pinned Notes run and job before activation. A newer Notes attempt blocks activation even when it succeeds for the same commit.

Rollback requires explicit authorization for the exact retained known-good receipt, even when its source heads have advanced. It uses the same metadata and byte checks and can restore the retained archive without fresh source evidence. If the archive is expired, missing or has a different digest, the gate leaves the active release in place.

The rehearsal uses unexpired GitHub artifacts for rollback verification. If the approved rollback window exceeds CI artifact expiry, the production adapter needs retained archives or restorable deployments with trustworthy stored identity and digest evidence. Production releases and rollbacks must share the same serialization gate. The activation adapter must keep the deployment and durable active receipt consistent across failures and retries.

The GitHub archive reader supplies `readArchive` after the receipt verifier checks metadata. It makes a GET with an Actions read token to the exact Portfolio artifact ZIP URL. It follows the one-minute signed HTTPS location immediately, omits credentials and GitHub headers on the storage request, and refuses further redirects. An expired or failed read returns an error without the token, signed location or underlying transport details. [GitHub artifact download contract](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact).

The API request has a 15-second deadline and the storage request has five minutes to retrieve the ZIP. The 1.25 GiB download ceiling leaves room for ZIP overhead above the roughly 1.07 GB expanded certification. The reader checks the declared length when present and counts actual bytes even when storage omits it. Both the transport and receipt verifier buffer archive bytes, so confirm memory headroom on the target runner before enabling publication.

### Rehearsal state inputs

Workflow outputs carry the receipt for the current run. GitHub artifact metadata identifies the Portfolio run and archive. For `readVerified`, persist the verified release receipt and the successful candidate build proof together in trusted durable storage after the checks and receipt binding pass. Include the exact Notes verification repository, ref, workflow ID, run ID and attempt, and the required job's success for the receipt's Notes SHA. Return the selected `notes_run_attempt` from source selection as `notesRunAttempt` alongside the receipt and Notes candidate in the trusted `readVerified` record. The stored proof binds that SHA and the snapshot manifest digest to the checked candidate.

Keep a separate durable history of confirmed known-good deployments with their exact receipts. For `readAuthorizedRollback`, look up the requested receipt in that history and require explicit rollback approval bound to the selected retained record. Return the stored receipt only when both the record and that approval match.

### D1 publication journal rehearsal

Run `npx vitest run tests/scripts/release-journal.test.ts` from `site` with Node 24.18.1. The suite applies `site/scripts/release-journal.sql` to a temporary SQLite database and executes the same statements the D1 adapter sends. It uses separate SQLite connections and fixture HTTP responses. [D1 SQL semantics](https://developers.cloudflare.com/d1/sql-api/sql-statements/). [D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

Before enablement, approve the Cloudflare account, dedicated D1 database, Pages project and canonical HTTPS origin as one configuration. Apply the schema to an approved empty database at cutover. Give the protected, serialized publication and rollback jobs a separate account-scoped token with D1 Write permission for the journal. Keep Pages credentials separate. Restrict journal writes to those jobs and approved maintenance. Treat the account-scoped token as capable of accessing other D1 databases in that account.

Each sequence is local to its Cloudflare account, project and origin. The journal retains every reservation and its terminal outcome, DB-generated UTC timestamps, the exact receipt, and either the verified Notes run and job identity or the approving rollback record's reference and known-good ID. A previous confirmed ID links to its receipt and deployment. The first reservation requires explicit first-cutover approval when there is no confirmed deployment. Record the existing host or DNS restoration plan separately.

While holding publication serialization, check for pending work before treating an active receipt as a duplicate. Reserve with the observed active ID and a stable operation UUID before any provider change. Use that UUID to correlate provider evidence and resume the pending operation after an interruption. Call `confirmAfterProviderProof` only after verifying the operation's exact production deployment and the canonical host. Call `abortAfterProviderProof` only after proving the operation is terminal without activation, or after proving the previous host state has been restored and the interrupted operation can no longer activate. An ambiguous provider or D1 outcome requires a fresh read and reconciliation before any further mutation. A rejected or timed-out D1 reply may follow a committed transition. The journal records the caller's externally verified decision and cannot determine hosting state.

### Cloudflare Pages provider rehearsal

Run `npx vitest run tests/scripts/release-pages.test.ts` from `site` with Node 24.18.1. The test uses fixture responses and an offline stand-in for Wrangler. At cutover, approve the exact Cloudflare account ID, Pages project name, production branch and canonical HTTPS origin. Supply the locked Wrangler 4.168.0 executable, which accepts the two provisioning opt-out flags. Stage the verified archive in a private runner directory outside the repository and pass the absolute real path of its static output. The adapter checks the receipt-derived marker bytes, checks the existing project's production branch, and runs `pages deploy` from a fresh empty sibling directory with a private configuration directory. The child receives the Pages credential through its minimal environment, and the adapter discards its output. [Get project contract](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/). [Wrangler Pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/). [Wrangler provisioning flags](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/index.ts).

The deployment lists the checked Portfolio commit and the commit message `portfolio:v1:<operation UUID>:<receipt SHA-256>`. The digest covers the eight receipt fields in the adapter's fixed serialization order. Under the same release serialization, lookup scans the bounded project deployment listing for a unique matching production operation. Cloudflare reports the total deployment count across both production and preview, so the lookup pages through the unfiltered history. The match must be for the exact project, production branch, Portfolio commit and receipt. Terminal success requires the completed `deploy` stage, success status and a deployment that was not skipped. CLI success records submission only. A missing record, conflicting records, incomplete pagination, schema change or in-progress stage leaves the operation pending. A canonical marker matching the prior release can coexist with a pending provider mutation. [List deployments contract](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/).

For an authorized rollback, read the approved known-good deployment UUID from the journal and verify its production status and exact receipt digest against the current provider record. Use that UUID for the rollback request and require the provider response to confirm the same deployment identity. The restored deployment retains its original upload operation UUID. Canonical marker and same-origin route checks must pass before recording confirmation in D1. A missing or unverified target leaves the operation pending, even when the original GitHub ZIP is still available. A retained successful production deployment can be restored after the ZIP expires. [Get deployment contract](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/). [Rollback API contract](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/). [Pages rollback retention](https://developers.cloudflare.com/pages/configuration/rollbacks/).

## Production publication and operator recovery

Production publication and operator work start disabled. Before enabling either job, approve the account, Pages project, D1 database, exact canonical origin, current protected source refs, Notes sender and operator. Configure the GitHub `portfolio-production` environment to allow deployments only from protected Portfolio `main`. Approve first cutover and the initial settings separately. After cutover, use branch restrictions that allow eligible routine publication without waiting for a human review on each run. The operator workflow still requires the approved numeric actor ID. Grant the source token read-only repository and Actions access as described above and keep the Cloudflare tokens in the protected environment. The build job cannot read those environment secrets.

| Setting                                                                                               | Approved value                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORTFOLIO_PRODUCTION_ENABLED`                                                                        | Repository flag. Exact lower-case `true` permits automatic publication from the protected candidate workflow after both jobs succeed.                                                                |
| `PORTFOLIO_PRODUCTION_FIRST_CUTOVER`                                                                  | Exact lower-case `true` permits an initial reservation when there is no confirmed release. Set it only for the approved first cutover and clear it immediately afterward.                            |
| `PORTFOLIO_PRODUCTION_AUTOMATIC_RESTORE`                                                              | Exact lower-case `true` permits a fresh failed publication to restore the verified previous deployment under the approved policy.                                                                    |
| `PORTFOLIO_PRODUCTION_OPERATIONS_ENABLED`                                                             | Repository flag. Exact lower-case `true` permits operator rollback and reconciliation independently of publication.                                                                                  |
| `PORTFOLIO_PRODUCTION_OPERATOR_ID`                                                                    | Approved numeric GitHub account ID. The first run attempt must carry this exact ID in the runner actor and dispatch sender.                                                                          |
| `PORTFOLIO_PRODUCTION_ORIGIN`                                                                         | Exact approved HTTPS origin with no trailing slash. Publication compares it byte for byte with `PORTFOLIO_RELEASE_ORIGIN` as selected by the candidate job.                                          |
| `PORTFOLIO_PRODUCTION_ACCOUNT_ID`, `PORTFOLIO_PRODUCTION_PROJECT`, `PORTFOLIO_PRODUCTION_DATABASE_ID` | Approved Cloudflare account ID, Pages project name, and dedicated D1 database UUID. The Pages production branch is `main`.                                                                           |
| `PORTFOLIO_PRODUCTION_LEGACY_PATH`, `PORTFOLIO_PRODUCTION_LEGACY_TARGET`                              | Optional exact same-origin source and destination paths from a reviewed redirect that both candidate and retained known-good releases serve as 308. Leave both unset while there is no such mapping. |
| `PORTFOLIO_PRODUCTION_JOURNAL_TOKEN`, `PORTFOLIO_PRODUCTION_PAGES_TOKEN`                              | Protected environment secrets with D1 Write and Pages Write permissions respectively for the approved account. Each adapter receives its own credential.                                             |

Both jobs use the repository's `portfolio-production` Actions concurrency group with `cancel-in-progress: false` and `queue: max`. Routine production writes go through this queue. Pages and D1 access outside the workflow is reserved for separately authorized emergency operations. The final provider read and upload or rollback are separate requests, so console or API writes that bypass the queue can race them. The queue can hold up to 100 waiting jobs, and eligibility is checked when work executes. GitHub may start eligible runs in a different order than dispatch time. [GitHub Actions concurrency syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

The publication runner tests the exact opt-in, installs the locked dependencies on Node 24.18.1, loads Python 3.12.14 and runs a credential-free input check. The execution step rereads the current protected Portfolio default branch and head and uses only the successful build's same-run receipt, selected Notes run and exact Notes run attempt. The coordinator rereads both protected heads and the Notes proof before staging and after reservation. The archive is written and verified in a private directory under the runner's canonical absolute `RUNNER_TEMP`. The staging adapter removes its own directory on exit. Python receives an empty environment. Wrangler 4.168.0 runs from an empty private directory with only the Pages token and runtime settings. The Pages adapter checks the exact immutable deployment, project serving deployment ID, and canonical release marker. The credential-free host smoke checks canonical home, Library, Interview and Search pages, the Pagefind runtime and English index metadata, a representative archive PDF and its file signature, and the approved 308 mapping when configured. The host probes use ten-second request deadlines, bounded bodies and exact same-origin destinations.

Use a new dispatch on the current protected `main` for every operator action. For rollback, obtain separate approval for the exact known-good journal sequence. Read the current active sequence, and confirm with the approved Pages project that the known-good deployment is still retained. The provider must confirm that deployment ID and receipt after the rollback. Record the retention window and test it at cutover, because Pages retention determines whether the rollback can still work after the original GitHub artifact expires. Use the actual sequence values and audit reference in this command.

```sh
gh workflow run portfolio-rollback.yml --repo angadsinghsandhu/angadsinghsandhu --ref main \
  -f operation=rollback \
  -f expected_active_id=42 \
  -f known_good_id=37 \
  -f reference=incident-123
```

Use dedicated reconciliation for an interrupted or pending journal operation.

```sh
gh workflow run portfolio-rollback.yml --repo angadsinghsandhu/angadsinghsandhu --ref main \
  -f operation=recover
```

The job logs its decision and journal operation number when available. `confirmed` records a newly confirmed activation or rollback. `noop` means the requested state required no new mutation after verification. `recovered` refers to previously reserved or restored work and succeeds only for a dedicated recovery dispatch. `pending` and `deny` fail the job. The immutable release receipt stays in the journal separately from the rollback approval reference.

If reconciliation remains pending, capture the journal operation number, operation UUID, expected prior deployment, exact provider deployment event or response evidence, and observed canonical marker. Freeze publication and escalate to the approved recovery owner. A missing listing entry, a prior marker, or a healthy previous host alone leaves a lost restore outcome unresolved. The wrapper has no terminal-restore or first-cutover failure proof callback. For a first cutover with no prior confirmed Pages deployment, use the separately approved DNS or withdrawal procedure when the host state cannot be established. Treat unresolved state as pending until independently recorded provider evidence and canonical smoke establish the exact result. Any out-of-band provider or journal recovery requires separate authorization and recorded evidence. Before routine enablement, verify the Pages project's `canonical_deployment` agrees with the canonical host before and after rollback on the approved destination. Disagreement keeps the operation pending.

Use the credential-free tests and the narrowly scoped actionlint exception during local verification. Actionlint 1.7.12 rejects the supported `queue` key. The workflow contract test pins that exact queue configuration. Remove this exception when actionlint supports the key.

```sh
actionlint -ignore '^unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"$' \
  .github/workflows/portfolio-release.yml .github/workflows/portfolio-rollback.yml

cd site
npx vitest run tests/release-workflow.test.ts tests/scripts/release-production.test.ts tests/scripts/release-smoke.test.ts
```

## Publish verified practice lessons

Keep `PORTFOLIO_PRODUCTION_TRACE_ENABLED` unset until the dedicated `portfolio-practice-traces` Worker serves its verified empty inventory at `/practice-traces/_catalog.json` on the canonical hostname. Use the exact route `angadsandhu.dev/practice-traces/*`, with alternate Worker URLs disabled. Put the account Workers Scripts Write token in the protected environment as `PORTFOLIO_PRODUCTION_TRACE_TOKEN`. The one-time route credential stays in local private storage and should be revoked after setup. The credential-free build and operator rollback read public trace proofs without this deploy token.

For a paired release, the serialized publisher stages both checked trees, probes the currently served release, and builds an additive Worker version from the verified new and retained packages. It checks protected source eligibility and the live inventory before deploying the Worker. The Worker must serve the exact new inventory and package bytes before Pages deployment can begin. A timeout can only advance when a fresh canonical probe proves the complete result. Recheck both protected sources before activating Pages.

Rollback verifies the known-good trace manifest and exact bytes on the canonical host before moving Pages traffic. The Worker retains all previously published content-addressed packages within its budgets. A release exceeding the budget stops before upload and requires a separate retention decision. The journal continues to identify the Pages deployment and retains the paired proof with the release receipt.

## Release checks

- Investigate every missing or extra route, fragment or search result. Fix the source or adjust the reviewed inventory before rebuilding. The Pages ceiling is 20,000 files and 25 MiB per file. Generated text is capped at 500 physical lines. Sitemap shards preserve all canonical URLs within that cap.
- Cloudflare Pages reads the generated `_redirects` when validated aliases exist. Each rule is a same-origin HTTP 308 with no destination fragment. The browser rehearsal verifies that an existing fragment reaches the canonical page with JavaScript disabled. A launch smoke test should repeat the check on the authorized Pages hostname. The generator rejects overlong declarations and refuses to emit more than 500 lines even though Pages supports 2,000 static rules.
- Review home and key library pages at 320px, tablet and desktop widths. Record the home LCP across multiple throttled Chromium loads, including the viewport, connection and CPU settings, and compare it with the 2.5 s target. Record physical-phone evidence when hardware is available.
- Verify navigation, search filters, direct book and folder links, PDF rendering and a real download. Exercise approved music playback and the approved résumé download when those materials are available. Isolated fixture playback proves the interaction only. Follow the editorial approval gate for any content still awaiting approval.

For each authorized deployment, retain the exact artifact, manifest digest, Portfolio and Notes revisions, hostname and deployment identifier. For subsequent releases, keep a known-good deployment and artifact ready to restore, then rerun the live smoke checks before closing a rollback. For the first deployment, record the prior hosting or DNS target and its restoration procedure. Record the rollback approver before cutover.

## Local release rehearsal

On 2026-11-24 UTC, the combined build from Notes `5b040f280bbad62df1e1a9172a0f2ca067afc504` was served from localhost. Home, Library, Interview and Search fit 320px, 768px and 1440px Chromium viewports. The reader suite exercised folder paths, anchors, search filtering and a rendered PDF.

The certified build held 16,040 files and preserved 9,023 canonical routes, including all 6,279 Notes reader routes. It verified 3,487 snapshot fragments, 6,279 search results and 505 bound files. The largest file was 21,722,117 bytes. The baseline comparison matched the parsed DOM of all 45 compacted reader pages after accounting for the new stylesheet fingerprint.

Chromium measured home LCP across five cold navigations at 360 × 780 CSS pixels. The test disabled the cache and used 4× CPU slowdown, 150 ms network latency, 1.6 Mbps download and 0.75 Mbps upload. The values were 464, 464, 456, 456 and 448 ms. The median was 456 ms against a 2.5 s target. The final LCP element was the home heading on all five runs. This is localhost emulation. Physical-phone and live-host checks remain release evidence.
