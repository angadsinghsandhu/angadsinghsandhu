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

The build uses clean, SHA-pinned checkouts. After standalone verification, it exports Notes into runner temporary storage, imports the export and receipt, builds with the approved origin, certifies the output, and runs the Chromium archive suite. The upload retains only `site/dist` as `portfolio-candidate-<run ID>-<attempt>`. The candidate workflow has no deployment job or hosting credentials.

After upload, the build job rereads the validated production snapshot and checks GitHub artifact metadata with the job’s read-only Actions token. The check binds the artifact ID, archive SHA-256, repository, Portfolio revision and exact run-attempt name, and requires a current expiration. On success, the job exposes its separate JSON `release_receipt` output with the Portfolio and Notes SHAs, snapshot schema and manifest digest, run ID and attempt, artifact ID, and archive SHA-256. A failed check leaves the job without a receipt. The receipt stays outside the archive.

Production publication requires an authorized Notes sender workflow and a publication gate connected to approved hosting and durable release state.

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

### Production state inputs

Workflow outputs carry the receipt for the current run. GitHub artifact metadata identifies the Portfolio run and archive. For `readVerified`, persist the verified release receipt and the successful candidate build proof together in trusted durable storage after the checks and receipt binding pass. Include the exact Notes verification repository, ref, workflow ID, run ID and attempt, and the required job's success for the receipt's Notes SHA. Return the selected `notes_run_attempt` from source selection as `notesRunAttempt` alongside the receipt and Notes candidate in the trusted `readVerified` record. The stored proof binds that SHA and the snapshot manifest digest to the checked candidate.

Keep a separate durable history of confirmed known-good deployments with their exact receipts. For `readAuthorizedRollback`, look up the requested receipt in that history and require explicit rollback approval bound to the selected retained record. Return the stored receipt only when both the record and that approval match.

### D1 publication journal rehearsal

Run `npx vitest run tests/scripts/release-journal.test.ts` from `site` with Node 24.18.1. The suite applies `site/scripts/release-journal.sql` to a temporary SQLite database and executes the same statements the D1 adapter sends. It uses separate SQLite connections and fixture HTTP responses. [D1 SQL semantics](https://developers.cloudflare.com/d1/sql-api/sql-statements/). [D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

Before enablement, approve the Cloudflare account, dedicated D1 database, Pages project and canonical HTTPS origin as one configuration. Apply the schema to an approved empty database at cutover. Give the protected, serialized publication and rollback jobs a separate account-scoped token with D1 Write permission for the journal. Keep Pages credentials separate. Restrict journal writes to those jobs and approved maintenance. Treat the account-scoped token as capable of accessing other D1 databases in that account.

Each sequence is local to its Cloudflare account, project and origin. The journal retains every reservation and its terminal outcome, DB-generated UTC timestamps, the exact receipt, and either the verified Notes run and job identity or the approving rollback record's reference and known-good ID. A previous confirmed ID links to its receipt and deployment. The first reservation requires explicit first-cutover approval when there is no confirmed deployment. Record the existing host or DNS restoration plan separately.

While holding publication serialization, check for pending work before treating an active receipt as a duplicate. Reserve with the observed active ID and a stable operation UUID before any provider change. Use that UUID to correlate provider evidence and resume the pending operation after an interruption. Call `confirmAfterProviderProof` only after verifying the operation's exact production deployment and the canonical host. Call `abortAfterProviderProof` only after proving the operation is terminal without activation, or after proving the previous host state has been restored and the interrupted operation can no longer activate. An ambiguous provider or D1 outcome requires a fresh read and reconciliation before any further mutation. A rejected or timed-out D1 reply may follow a committed transition. The journal records the caller's externally verified decision and cannot determine hosting state.

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
