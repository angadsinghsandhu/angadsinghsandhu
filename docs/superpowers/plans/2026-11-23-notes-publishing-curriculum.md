# Notes Publishing and LeetCode Curriculum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Maintain the Notes archive and publishing input for the portfolio, then author, verify and publish original lessons with solutions for LeetCode IDs 1–2000.

**Architecture:** Build the Notes-only export from the trusted preparation pipeline and validated curriculum content. Portfolio consumes the export and owns public presentation, search, playback and hosting. No second public Notes UI is planned.

**Tech Stack:** Existing Notes TypeScript, Astro verification tooling, Python curriculum checks and GitHub Actions.

**Spec:** [Approved portfolio and Notes design](../specs/2026-11-23-portfolio-notes-design.md). Follow the [master sequence](2026-11-23-portfolio-notes-master.md).

## Global Constraints

- Archive and authored materials stay in Notes. Start from reviewed committed inputs. Keep the parked worktree and its nine changes intact. This plan supersedes the October LeetCode Notes-specific task sequence.
- Keep published routes, fragments, stable identities, source provenance and archive checks. Reuse verified committed code after a compatibility check. Green CI at `fc304f3` provides no evidence about parked file contents.
- Every official ID in 1–2000 has an explicit record. Author original explanations and solutions. Link the official problem and cite evidence without copying proprietary statements or examples. Company associations require dated sources; omit unsupported assertions.
- Every materially distinct approach gets annotated code, a correctness argument, time and space complexity, curated examples and its own execution-backed visualization data. Order from less efficient to more efficient when helpful and omit contrived variants.
- Keep draft records and associated code, trace payloads and lesson pages out of production. Portfolio owns Astro routes, player UI, Pagefind, public navigation, and private progress.
- Obtain authorization for provisioning, merge, initial production cutover, notification secret activation and cleanup. Once enabled, automatic CI/CD sends eligible updates to Portfolio.

- Apply the **500-line maximum** in the design to every new, transferred or changed non-test text file. At N0 record the exact base inventory of existing oversized files. At N1 add a required line-count check to Notes verification. Untouched historical files stay identifiable by path and blob hash. A changed historical file must pass, and moving or copying an oversized file cannot grandfather it. Use the Portfolio Task 1 boundary cases; run the check from the first Notes change onward.

## Review Focus

Test a renamed source with stable IDs and redirects in N1/N2, a conflicting assignment of one source to multiple identities in N3, divergent trace/digest and draft visibility in N4, missing IDs in N5/N6, and authorized post-cutover cleanup without losing author preview in N7.

## Notes file map

| Paths | Responsibility |
| --- | --- |
| `site/content/publication.json`, `site/content/organization/`, existing archive roots | Source of truth for eligibility and organization |
| `site/scripts/export-portfolio.ts`, `site/tests/scripts/export-portfolio.test.ts` | Notes-to-Portfolio snapshot |
| `site/content/leetcode/manifest.json`, `paths/`, `source-map.json`, `problems/<id>/` | Target coverage, path definitions, source records and lessons |
| `site/scripts/curriculum*.py`, `site/src/content/leetcode/`, `site/tests/` | Established curriculum preparation and verification |
| `site/content/leetcode/batches.json`, `coverage-report.json` | Account for every target and record proof of promotion |
| `.github/workflows/notes-site.yml` | Existing source verification and approved future notifications |
| `docs/superpowers/` | Active pointers and historical supersession notices |

### N0. Record the clean starting point

- [x] Inventory current integration PRs and choose a clean Notes feature base. Compare the reviewed library baseline with `fc304f38e9757064537c094a4fb71c6447946920`; record which committed prerequisites are inherited or separately ported.
- [x] Verify all nine parked checksums without modifying the checkout. Run Notes `npm run verify` from a clean feature checkout with the baseline toolchains (Node 24.18.1 and Python 3.12.14) and full Chromium. Confirm route/source parity against the documented 6,279 reader routes and 10,031 original source records. Explain each reviewed difference.

### N1. Export the approved archive

**Files:**Notes `site/scripts/export-portfolio.ts`, `site/tests/scripts/export-portfolio.test.ts`, `site/package.json`.

**Produces:** `npm run export:portfolio -- --out <staging-dir> --revision <sha>`. Output contains `manifest.json`, Pages assets under `assets/` and digest-named packages under `worker-assets/practice-traces/`. Manifest v1 includes `mode` (production or preview), the projected curriculum and trace inventory, `schemaVersion: 1`, `sourceSha: string`, `entries`, `organization`, `assets`, and `verifiedCurriculumIds: number[]`. Each entry provides stable ID, title, kind, canonical route, aliases, heading IDs, safe HTML or approved resource representation, publication/search metadata and original-source action where applicable. Each asset records normalized public path, export-relative path, bytes and SHA-256. An empty lesson list is valid.

- [x] Add scenarios named `exports only reviewed publication entries`, `rejects a mismatched checkout revision`, and `leaves no partial export after failure`. Assert the draft Two Sum is absent, approved HTML matches the existing pipeline, assets match registered digests and temp writes cannot replace a verified destination. From Notes `site/`, run `npx vitest run tests/scripts/export-portfolio.test.ts` and observe the missing exporter failures.
- [x] Implement the CLI as a wrapper over the existing preparation and validation. Build into a fresh sibling directory, validate and finish the export atomically. Scope output paths to the supplied staging area. Keep the Notes-only verification workflow and current preview behavior available through cutover.
- [x] Rerun the focused suite. Run the serialized repository gate on the finished Notes change. Compare the export inventory with N0 and record explained differences. Commit the exporter in Notes.

- [x] Check in one versioned schema and a minimal consumer fixture with the exporter. Pin both in Portfolio consumer tests. Include the validated generation-bound curriculum projection (eligible prepared lessons, path membership and package inventory) alongside the archive entries. The set of verified frontend numbers must equal the lesson payload and route IDs. Export safe pending path labels separately. Omit draft bodies, code and packages entirely. For browser acceptance, use a disposable copy of reviewed draft inputs to exercise the verified-only transcript and package generator. Never write synthetic promotions back to authored data. Label isolated fixture exports as preview in the manifest and require production mode at the release entry point.
- [x] Include a rename that preserves the stable ID and resolves the old route. Build twice from the same clean SHA and compare the manifest and all payload digests. Bind the resulting manifest SHA-256 to the CI artifact receipt outside the snapshot. A dirty tracked input or an untracked publishable source invalidates a release export even if HEAD matches. Use fresh, uniquely named output directories and make a completed export visible only after all checks succeed.

### N2. Verify authoring and notifications

- [ ] Exercise create, edit, rename and removal from the Notes authoring workflow. Assert the next snapshot reflects each reviewed change, has no stale entries and excludes private/draft content. Preserve the existing Notes-only verification path through cutover.
- [ ] Run required Notes verification on every PR open, reopen and update. Exercise the 500-line check, archive parity, curriculum checks and exporter contract. On push to the approved publication branch, reverify the exact landed SHA. Test that a successful source edit triggers one effective Portfolio release and that a failed run produces no dispatch.
- [ ] Extend the trusted branch workflow only after confirming publication ref policy. Emit the exact verified full SHA and dispatch only after successful upstream CI once production automation is authorized. Test false cases for PR refs, failed runs and mismatched revisions. Keep secrets and production dispatch disabled for pull requests. Portfolio plan Task 6 owns receiving and deployment verification.

### N3. Reconcile official identities and pilot evidence

- [ ] Before editing the large baseline catalogs, split authored manifest, source-map and path records into bounded, readable files by problem range or path stage. Use a small ordered index per collection, with further subdivision wherever formatting exceeds 500 lines. Compare the assembled records with the original full dataset, including order, hashes, references and statuses. Keep the logical curriculum schema stable for TypeScript preparation, Python verification, publishing and authoring. Test both the legacy layout and the new layout, including missing and duplicate shards. Apply the same rule to new batch, coverage and trace files. Generated aggregate views belong in build staging.
- [ ] Begin with the target manifest, the 366 archived solutions and original byte hashes. Reconcile archived filenames to official IDs using evidence. Keep ambiguous matches and unavailable facts explicit. Do not infer identity from a filename alone.
- [ ] Resolve and record the eight pilots, IDs **1, 3, 20, 64, 98, 127, 146 and 175**. Record official URLs, identity evidence, constraints with provenance, archive or new-code origin, and selection of meaningful approaches. Check the current records rather than repeating already verified research.
- [ ] Run the curriculum validator against one archive source assigned to conflicting IDs (multiple genuine variants of one problem are valid), a wrong official URL and missing official evidence. Assert those records cannot be promoted. Commit the approved pilot evidence separately from publication.

### N4. Complete the eight pilots and lock the lesson standard

- [ ] Review Two Sum and its existing three approaches, three examples and nine traces against the new snapshot and renderer boundary. Reuse accepted committed components and traces. Treat any parked implementation as a separate reference requiring explicit review before selective transfer.
- [ ] Author the other seven pilots in `site/content/leetcode/problems/<id>/`. Each lesson set has original prose, metadata, tested annotated solutions, curated examples, and one deterministic visualization trace set per approach. Include edge cases for each approach, independently checked outputs, correctness and complexity, and trace bounds.
- [ ] Write failing behavior tests first. Check #1 distinct indices with duplicates, #3 a shrinking repeated-character window, #20 an unfinished stack, #64 a single column and input mutation, #98 an ancestor-bound violation, #127 an unreachable target, #146 overwrite/eviction order and #175 SQL NULLs and multiple matches. Test the native language and declared SQL semantics. For #64 cover top-down matrix and bottom-up space tradeoffs, and for #98 compare recursive and iterative approaches.
- [ ] From Notes `site/` run `python3 -B scripts/curriculum.py check --ids 1,3,20,64,98,127,146,175` on macOS and Ubuntu with the pinned Python. Exercise reviewed implementations only in the bounded harness. Compare intermediate transitions with an independent oracle, verify 1–2,000 frames and at most 1 MiB per example, and compare source-line references to displayed code. Check solution results, deterministic traces, file digests, execution bounds and draft exclusion. Reject a trace whose expected output or digest diverges.
- [ ] Hand isolated draft fixtures to Portfolio for canonical reader, player, transcript and study-tree acceptance. Keep fixture and production exports separate. Promote pilots only after independent teaching review and connected browser proof on all eight. Verify public payloads and update counts to 8/2,000 only after all eight pass.

### N5. Produce and publish the remaining lessons in waves

- [ ] Generate a deterministic 40-wave registry covering ranges 1–50, 51–100, through 1951–2000. Use it for accountability, with pedagogical order tracked separately. Verify every ID is assigned once. Already verified pilots retain their positions and are not recreated. After eight pilots there are exactly **1,992 remaining lessons**.
- [ ] Complete official identity evidence for remaining targets. Split waves into reviewable groups of up to five lessons. For each ID apply the pilot standard, with original explanations and code, annotated approaches, proofs, complexity, curated examples and execution-backed traces. Record explicit blockers where official evidence is insufficient. A blocked or draft target cannot count as verified.
- [ ] For each group, run solution, trace and metadata checks, independent teaching and code review, and Portfolio fixture rendering on the actual changed input. Promote only when every required check passes. Record lesson and trace digests and review outcome with the promotion. Record the actual promoted Notes SHA, Portfolio SHA, artifact digests and verified/live coverage delta in a subsequent CI receipt so the source commit never needs to contain its own hash.
- [ ] Before promoting each group, measure Pages and Worker artifacts independently, including index growth and retained rollback packages. Project full-catalog counts from pilot measurements and update the projection after each wave. If the 20,000-file or 25 MiB file limit becomes binding, pause affected promotions and prepare a separate packaging decision. Do not drop existing routes or hide missing IDs to pass the gate.

### N6. Prove curriculum completion

- [ ] Check equality of verified IDs with the set 1–2000. Reject any missing, duplicate, blocked or draft target in the completion report. Check that each verified lesson has source, solution, test, trace, teaching review and public-route proof.
- [ ] Run full Notes verification and combined Portfolio parity, search, assets, public eligibility and route checks at pinned SHAs. Record evidence and final verified count. Completion and production release are distinct decisions.

### N7. Remove redundant Notes hosting only after cutover

- [ ] After the live portfolio proves parity, inventory Notes preview consumers, export dependencies and legacy links. Propose an explicit file-level cleanup diff. Keep archive and authored data, CLI, approved checks, and any authoring preview identified as useful.
- [ ] Obtain cleanup authorization before removing obsolete Notes deployment wiring or redundant presentation. Run Notes export, archive checks, authoring smoke and the combined Portfolio build after cleanup.
