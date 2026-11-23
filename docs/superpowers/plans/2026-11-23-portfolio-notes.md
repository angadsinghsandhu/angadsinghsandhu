# Portfolio and Notes Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a release candidate for Angad's public portfolio and integrated Notes library that preserves the archive, supports reviewed content updates, and launches independently of LeetCode completion.

**Architecture:** Notes generates a versioned, sanitized publication snapshot from a reviewed commit. The portfolio combines that snapshot with its own public routes in a static Astro build, and GitHub Actions verifies an immutable artifact for Cloudflare Pages Direct Upload. Private study progress is a separate portfolio Worker and D1 project milestone.

**Tech Stack:** Astro, TypeScript, selective React, Pagefind, PDF.js, Vitest, Playwright, GitHub Actions, Wrangler and Cloudflare Pages.

**Spec:** [Portfolio and Notes design](../specs/2026-11-23-portfolio-notes-design.md), approved in discussion.

The [master plan](2026-11-23-portfolio-notes-master.md) controls execution order. The [Notes plan](2026-11-23-notes-publishing-curriculum.md) owns upstream work; Task 2 identifies the N1 handoff.

## Global Constraints

- Portfolio repo is `angadsinghsandhu/angadsinghsandhu`. Notes repo is `angadsinghsandhu/Notes`. Keep the portfolio root README byte-for-byte and keep the archive, metadata and publishing policy in Notes.
- Reviewed engineering baseline is `fc304f38e9757064537c094a4fb71c6447946920`. It is eligible for local/CI compatibility work; an approved production ref and exact-SHA validation are required for production. The preservation audit reported 6,279 canonical reader routes and 10,031 original source records. Review every baseline difference.
- Keep `/Users/angad/.codex/worktrees/notes-website/Notes` and its nine parked changes intact. Design approval does not resume the LeetCode worktree. Use clean, separate checkouts and focused commits on feature branches.
- Serve a dark-only public site. Use `#0d0d0f`, `#161618`, `#f4f1ee` and exact brand red `oklch(52.768% 0.21534 29.097)`. Use Geist and IBM Plex Mono. Keep motion optional and public routes static.
- Keep the combined output within 20,000 files and 25 MiB per file or stricter applicable Free limits. Target home LCP at or below 2.5 seconds in a documented throttled mobile test. Do not drop archive routes to satisfy a budget.
- Build and test locally and without production secrets in pull requests. Obtain authorization for merge, provisioning, initial activation and cutover, and post-cutover deletion. Subsequent routine releases use automatic CI/CD. No accounts for public visitors.
- Only Angad uses Bitwarden. Store local working secrets outside Git with directory mode `700` and file mode `600`; separate environments. Runtime and CI credentials live in the respective Cloudflare or GitHub secret stores. Keep secrets out of logs, process arguments, bundles and artifacts.

- Apply the **500-line maximum** in the design to every non-test text file in the new Portfolio codebase, including ported modules, styles, documentation, metadata and dependency locks.

## Review Focus

- **Route and fragment regression** → Task 4 resolves actual canonical and alias links, including encoded characters, trailing slashes and fragment IDs.
- **Unauthorized or stale input** → Task 6 rejects wrong-repo, wrong-ref, stale, failed and mismatched SHA events before publication.
- **Partial snapshot or archive leakage** → Tasks 2 and 3 validate exact export and asset membership, reject drafts and unsafe paths, and preserve the prior verified input on failure.
- **Large library and media blow the same budget** → Task 5 checks aggregate files and per-file sizes after Pagefind and PDF assets are present.
- **Mobile readers cannot navigate without hover** → Tasks 1 and 4 exercise real 320px navigation and keyboard/reduced-motion paths.

## Repository map

| Repository | Paths | Responsibility |
| --- | --- | --- |
| Notes | `site/scripts/export-portfolio.ts`, existing `site/src/content/` and `site/src/lib/catalog.ts` | Reuse current preparation to write the versioned export |
| Notes | `site/tests/scripts/export-portfolio.test.ts`, `site/package.json`, existing `.github/workflows/notes-site.yml` | Export, authoring and upstream validation |
| Portfolio | `site/src/layouts/`, `site/src/pages/`, `site/src/components/`, `site/src/styles/tokens.css`, `site/src/content/` | Public shell, editorial routes and adapted Notes readers |
| Portfolio | `site/src/lib/notes-snapshot.ts`, `site/scripts/import-notes.ts`, `site/scripts/verify-output.ts`, `site/tests/` | Verify import, preserve routes, index eligible content and check deployment output |
| Portfolio | `.github/workflows/portfolio.yml`, `site/scripts/release-policy.ts`, `docs/portfolio-release.md` | Rebuild, verify provenance, release controls and rollback |

---

### Task 0. Record baselines and isolate the work

- [x] Create separate feature checkouts with git-worktree guidance. Record the portfolio README object ID, legacy index anchors and asset/link disposition in `docs/portfolio-migration.md`. Keep the old site recoverable in Git history.
- [x] Inspect the latest Notes integration PR bases before choosing a Notes feature base. Use the reviewed SHA for compatibility and do not assume the draft LeetCode stack must merge. Run `shasum -a 256 -c` against the handoff file `.superpowers/sdd/2026-10-24-leetcode-learning-platform/PARKED_NOTES_FILES.sha256` from the parked checkout before and after the work.
- [x] On a clean Notes copy, run `cd site && npm ci && npm run verify` with Node 24.18.1, Python 3.12.14, both pinned Python requirements files from Notes CI, full Chromium, a configured HTTPS `SITE_URL` and the actual `SOURCE_REVISION`. Serialize checks using the Notes browser port. Capture the committed revision, eligible route/alias/anchor inventory, archive parity result and file count/largest asset. Log expected differences if an independently reviewed base is selected later. Commit the inventory to the portfolio feature branch.

### Task 1. Build the portfolio shell and editorial routes

**Files:** Portfolio `site/package.json`, `site/astro.config.mjs`, `site/src/layouts/SiteLayout.astro`, `site/src/styles/tokens.css`, `site/src/components/HomeSignal.astro`, `site/src/pages/` and `site/tests/portfolio.spec.ts`.

- [ ] Add `npm run check:lines` to the required Portfolio verification command and PR workflow from the first shell change. Enumerate repository text inputs including added files, using Git paths and file contents, with exemption only for actual test modules. Test 500 accepted, 501 rejected, CRLF, a missing final newline, a genuine long test accepted, and a 501-line fixture under tests rejected. Format first and report every offending path and count. Run the same gate on the final tree before each PR.
- [ ] Prove dependency reproducibility at bootstrap. The reviewed Notes npm lock exceeds 500 lines, so copying it into Portfolio fails the rule. For a dependency graph that exceeds one readable lockfile, store losslessly split lock metadata by package group and assemble the standard lock in a disposable install directory. Verify a round-trip including integrity fields and a clean frozen install. Use an ordinary in-limit lock if it fits. Do not compact JSON or waive generated tracked files.
- [ ] Add Playwright cases for primary navigation at 320px and desktop, reduced-motion home with visible static artwork and actions, and valid links from each first-release index. Run `npx playwright test tests/portfolio.spec.ts` from `site/`; initial failure is missing routes or controls.
- [ ] Replace the legacy `site/` on the feature branch with static Astro. Implement `/`, `/projects/` and detail pages, `/resume/` with a stable PDF URL, `/music/` and release pages, `/blog/`, `/movies/`, `/interesting/` and `/interview/`. Use structured draft/approved content, explicit empty states and fixture-only sample media. Acquire public copy/assets from Angad. Serve the hero artwork statically with its once-only pulse and replay, and keep optional React/media hydration off the initial path.
- [ ] Verify the supplied résumé PDF downloads and the approved embed begins on request before release. Confirm `npm run build` and the portfolio browser suite pass. Verify the README object ID matches Task 0 and commit the shell.

### Task 2. Notes handoff

The exporter is implemented once, in Notes N1. Task 3 starts when N1 provides the v1 fixture, schema and full-revision sample export. Portfolio Tasks 1 and 3 may use the shared fixture during development. A release candidate requires the real Notes export.

### Task 3. Import and validate the snapshot in Portfolio

**Files:** Portfolio `site/src/lib/notes-snapshot.ts`, `site/scripts/import-notes.ts`, `site/tests/notes-snapshot.test.ts`.

**Consumes:** Notes N1 snapshot. **Produces:** `readNotesSnapshot(dir: string, expectedSha: string): Promise<NotesSnapshot>` and `npm run import:notes -- --from <staging-dir> --revision <sha>`. The output is a build-only generated folder. Copy only allowlisted Pages assets to the static site. Validate Worker packages against their separate inventory. A preview fixture must fail the release build even when its routes and digests are otherwise valid.

- [ ] Test exact schema version and SHA, integrity and size, duplicate IDs/routes, paths outside the export root, symlinks, unlisted files and an interrupted import. Assert the importer rejects each invalid input without replacing the last verified snapshot. Run `npx vitest run tests/notes-snapshot.test.ts` before implementation.
- [ ] Implement validation and stage-to-final promotion. Require the exact digest of the exporter manifest from the upstream handoff, verify all listed bytes and reject mismatched curriculum generations. Keep a small synthetic snapshot fixture plus proof against the full reviewed Notes export. Never serve the raw checkout or the private manifest.
- [ ] Verify the targeted suite and import the real snapshot with the expected full SHA. Commit the importer and fixtures.

### Task 4. Integrate Notes, Interview and search

**Files:** Portfolio `site/src/pages/library/`, `site/src/pages/notes/`, `site/src/pages/resources/`, `site/src/pages/search.astro`, `site/src/pages/[...alias].astro`, `site/src/pages/interview/`, `site/src/components/notes/`, `site/src/lib/notes-routes.ts` and `site/tests/notes-reader.spec.ts`.

**Consumes:** Task 3 validated snapshot. **Produces:** `claimNotesRoutes(snapshot: NotesSnapshot, existing: ReadonlySet<string>): RouteClaims`, with each canonical route and alias assigned one owner. Keep Notes and other portfolio paths under one canonical origin.

- [ ] Test real Notes folder links, encoded/renamed aliases and preserved fragments, searchable approved content with scopes, and a viewable PDF or original-source action. Test phone Browse/Search/On this page, malformed and conflicting routes, keyboard use, and the missing-curation Interview fallback. Run `npx playwright test tests/notes-reader.spec.ts` and observe initial failures.
- [ ] Port the reviewed reader, reader navigation, folder tree, collection/topic/path views and PDF viewer presentation with their focused tests. Adapt their theme and navigation to the shell. Build one Pagefind index preserving the learning/file scopes, metadata filters and source access for supplemental material. Check the React project tree, PyTorch chapter grouping and interview paths against the reviewed organization snapshot. Render Interview using approved metadata with the spec fallback. Reserve `/practice/leetcode/`, `/practice/leetcode/<id>/`, `/practice/paths/` and `/practice/paths/<id>/` without creating draft lesson routes.
- [ ] Run reader browser cases and compare every route and anchor from Task 0 with the combined output. Exercise additions, edits, renames and deletions through export and rebuild. Review differences and commit the integration.

### Task 5. Certify the combined artifact

**Files:** Portfolio `site/scripts/verify-output.ts`, `site/tests/output.test.ts`, `docs/portfolio-release.md`.

- [ ] Add named cases for an over-limit file, too many files, hidden draft payload and missing local fragment. Assert a nonzero failure before any artifact qualifies. Run `npx vitest run tests/output.test.ts` before implementation.
- [ ] Implement `npm run verify:output -- --dir dist` to check real output after sitemap, redirects, Pagefind and PDF assets are emitted. Report counts, largest assets and route differences. Check assets and canonical URLs against expected origin, public inventory and route list. Keep provenance available to CI and out of search.
- [ ] Run `npm run build && npm run verify:output -- --dir dist && npx playwright test` with the real snapshot. Record throttled mobile LCP and checks at 320px, tablet and desktop, and on a physical phone where available. Include approved content, playback, download and navigation evidence for release review. Commit the verifier and runbook.

### Task 6. Connect automatic CI/CD before cutover

**Files:** Portfolio `.github/workflows/portfolio.yml`, `site/scripts/release-policy.ts`, `site/tests/release-policy.test.ts`; Notes `.github/workflows/notes-site.yml` or a dedicated bridge workflow once authorized.

**Produces:** `evaluateNotesRevision(candidate: NotesCandidate, evidence: EligibilityEvidence): EligibilityResult`. Evidence binds the allowlisted Notes repo, approved protected ref, full lowercase 40-character SHA, trusted workflow and successful verification for that same SHA. A release receipt records Portfolio SHA, Notes SHA, snapshot schema, run and artifact IDs, and artifact digest.

- [ ] In `.github/workflows/portfolio.yml`, run the required verification job on PR open, reopen and update. Bind its result to the current revision. Include line count, format, lint, types, boundaries, unit tests, combined build, output checks and browser tests. Prove a failing PR cannot qualify for merge or reach a deploy job.
- [ ] On a push to protected `main`, verify that Portfolio SHA with the current eligible Notes SHA. On an authenticated Notes dispatch, verify that Notes SHA with current Portfolio main. Rehearse both events in staging, including duplicate delivery of the same pair. Each eligible pair should result in one effective release. Failed and stale candidates must leave the active release intact.
- [ ] Test invalid repo/ref/SHA, missing or non-success verification, SHA differing from the successful run, a superseded Notes or portfolio revision, and an artifact from the wrong run or digest. Assert denial. Test explicit eligible rollback separately. Run `npx vitest run tests/release-policy.test.ts` before implementation.
- [ ] Build and verify from clean checkouts without production credentials, pin workflow actions by SHA, and upload the exact checked artifact. Make authorized Notes notifications request a fresh portfolio build with the verified SHA, never direct uploads. Manual retries use the same proof. Serialize uploads and recheck freshness inside that gate. Keep deployment disabled until the target environment and source ref are approved. Grant deployment credentials only to the authorized job.
- [ ] Pass pull request verification and simulated notification/rejection tests. Demonstrate two competing release requests and reject the stale one. Rehearse artifact and rollback verification without using hosting credentials. Commit each repository's workflow changes separately.

### Task 7. Release and retire with separate approvals

**Files:** Portfolio `docs/portfolio-release.md`; Notes deployment wiring and duplicate presentation files only after a later cleanup decision.

- [ ] Collect approved homepage copy, résumé/PDF, projects, music credits and playback source, host/DNS context and the production-eligible Notes ref. Record decisions for any Music-index or Pages-hostname fallback. Record prior public Notes URLs if any, their redirect map and rollback owner.
- [ ] Present the two repository diffs, exact input SHAs, combined build and route parity report, tested artifact digest, and rollback runbook. Obtain authorization for merging, provisioning and the initial production cutover. Document the approved automatic release and rollback scope in the runbook.
- [ ] At cutover, enable automatic deployment of each eligible checked artifact with Wrangler, verify key public and legacy paths against the canonical host, and record the release receipt. On gate or smoke failure, use the rehearsed recovery decision. For a first deployment, record the prior DNS/hosting target or the procedure to withdraw the new host. For subsequent deployments restore the retained known-good release and smoke-test it. Record who can authorize rollback before cutover.
- [ ] Once cutover parity is established, inventory remaining Notes preview consumers. Propose a separate cleanup diff for redundant Notes public deployment wiring and obsolete presentation. Preserve authoring and validation coverage and request cleanup authorization.

### Task 8. Connect the numeric reader and player to the eight pilot fixtures

- [ ] From Notes N3/N4 obtain one isolated candidate snapshot of the eight pilots and one production snapshot with zero verified IDs. Build both with the same renderer. In Portfolio add `site/src/pages/practice/leetcode/[number].astro`, reader/player components and mirrored tests. Claim each eligible numeric route once. The public build must exclude draft HTML, trace bytes, source snippets, sitemap entries and search hits.
- [ ] Port the reviewed controller, loader, code highlighting and transcript presentation with their tests. In full Chromium, open every pilot by URL, follow official and original-source links, and verify complete transcripts with JS disabled. Activate each approach on demand. Assert the fetched package digest, visible step, code lines and transcript agree while stepping both ways, resetting and switching examples. Exercise timeout/corrupt package with the static lesson still readable.
- [ ] Serve Pages and Worker assets together in staging. Verify keyboard, touch, reduced motion, speed, focus and pause on hide/scroll. Record both artifact digests. Upload immutable packages before referencing HTML on an authorized release. Retain previous packages for rollback and check that the previous HTML still loads its traces.

### Task 9. Ship discovery and study paths, then promote the pilots

- [ ] Implement the LeetCode index and path index/detail routes under `site/src/pages/practice/`. Test number/title search, URL-backed topic/difficulty/company filters and empty results. Index eligible lesson prose once. Preserve archive search and source links.
- [ ] Render the validated Notes DAG as an expandable tree and ordered outline. Test repeated references, pending targets, deterministic next-ready ordering and exact unique coverage. Confirm the all-problems path accounts for 2,000 identities and exposes links for eligible lessons only.
- [ ] Record the eight reviewed lesson content digests against the tested Portfolio SHA. Notes N4 promotes those exact bytes in one candidate. Rebuild from the promoted Notes SHA using the production policy, check all eight routes and packages and confirm a draft fixture is rejected. Record verified and live counts separately. Deploy through the authorized release path.

### Task 10. Add private progress after the pilot gate

- [ ] In a separate Portfolio Worker package, start with a local D1 migration and mirrored repository tests. Key rows by owner and stable problem ID. Save studied state, lesson revision, server timestamp and version. Two clients updating one version yield one accepted change and one conflict with fresh state. Retrying an already applied intended state leaves the row consistent.
- [ ] Implement same-origin `/account/` and `/api/progress/` routes plus authenticated versioned JSON export. Check signed Access token, issuer, audience, expiry and exact owner. Test missing/expired credentials, wrong owner, unprotected alternate ingress, invalid ID, wrong origin and conflicting writes. Use bounded inputs, bound SQL and private no-store responses. Verify export and recovery against local data.
- [ ] Add reversible studied controls to lessons, cards and paths. Test two browser contexts, stale revisions, offline failure, retry, sign-out and expired login. Refresh after sign-in/focus/write and ask for confirmation before replaying an interrupted action. Anonymous readers retain public reading when the API is down. Check built HTML, caches and Pagefind for owner data. Require separate authorization and real-host smoke tests for Access, D1 and Worker activation.
