# Portfolio and Notes Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Follow the order below and track each gate before starting dependent work.

**Goal:** Launch the portfolio with the reviewed Notes library, then ship the integrated LeetCode reader, all 2,000 verified lessons, and private study progress.

**Architecture:** Notes owns the archive, publishing pipeline, source evidence, solutions, and trace generation. Portfolio owns the public Astro site, lesson and library readers, search, deployment, and private study progress. A versioned snapshot pinned to an exact Notes SHA joins the two.

**Tech Stack:** Astro, TypeScript, React where needed, Pagefind, PDF.js, Python, GitHub Actions, Cloudflare Pages, and later Cloudflare Access, Workers, and D1.

**Spec:** [Approved design](../specs/2026-11-23-portfolio-notes-design.md).

**Active execution plans:** [Portfolio implementation](2026-11-23-portfolio-notes.md) and [Notes publishing and curriculum](2026-11-23-notes-publishing-curriculum.md). This master controls sequence if either plan describes work in a different order. The October Notes LeetCode design and its two plans are historical records. Do not resume their task lists or replay parked changes as a batch.

## Global Constraints

- Work only from separate clean feature checkouts. Preserve the profile README, Notes archive, stable IDs and URLs, and all nine parked worktree files. Review committed reuse candidates individually.
- The exact engineering baseline is Notes `fc304f38e9757064537c094a4fb71c6447946920`. It is a compatibility reference. Production uses a separately approved protected ref and successful CI for the exact published SHA.
- Use the verified artifact and the approved Cloudflare Free budget. Keep drafts, raw archive payloads, secrets, and private progress out of release output. Launch without claiming unverified lessons.
- Obtain authorization for merge, provisioning, initial production cutover and post-cutover cleanup. Cutover enables automatic CI/CD for routine releases from the approved branches. This plan changes planning documents only.

- Enforce the design’s **500-line maximum** for every non-test text file in the new codebase. Phase 0 inventories the starting point. The first implementation change in each repository wires the check into its required gate. Every later phase, including imports and curriculum batches, must pass it.

## Review Focus

- Public launch cannot wait for the first lesson, private progress, or all 2,000 targets. Prove an empty verified-curriculum snapshot builds correctly in phase 3.
- Portfolio cannot depend on a parked or mutable local revision. Bind two repository SHAs and the artifact digest in phases 2–4.
- Transferred code must preserve library behavior and ownership. Run baseline route, fragment, source, search and PDF parity in phase 3.
- A curriculum lesson cannot appear in production while under review. Prove fixture preview and production exclusion before first publication in phase 5.
- Completion must be exact set equality with IDs 1–2000. Phase 7 checks for gaps, duplicates, schema failures, and incomplete evidence.

## Execution order

| Order | Work | Can overlap | Gate to advance |
| --- | --- | --- | --- |
| **0. Baseline and branches** | Portfolio Task 0 and Notes N0. Check current PR bases, archive inventory and parked checksums, and choose separate clean feature bases. | No edits before baseline evidence. | Both repositories have recorded revisions, preserved archive evidence and clear ownership. |
| **1. Shell and export contract** | Portfolio Task 1 and Notes N1. Build the portfolio shell with fixtures. Wrap the reviewed Notes preparation pipeline in a versioned export. | These can proceed independently once the snapshot interface is agreed. Begin collecting approved content and domain decisions. | Dark responsive shell builds. Notes exports the eligible archive with no public LeetCode drafts. |
| **2. Import and publishing proof** | Portfolio Task 3 consumes Notes N1. Notes N2 verifies source edits and CI compatibility. | Run Notes authoring and Portfolio import checks together. | Import rejects malformed or partial snapshots and verifies exact revision and asset integrity. |
| **3. Library and launch candidate** | Portfolio Tasks 4 and 5. Verify combined routes, aliases, fragments, search, viewer, assets and phone performance. | Once the snapshot contract is stable, start Notes N3 pilot evidence and N4 preparation in a separate clean branch. | Release candidate serves approved Notes/Interview material. A build with zero verified lessons passes the same launch gate. |
| **4. Authorize and launch** | Portfolio Tasks 6 and 7, with Notes N2 notification wiring. Finalize the approved Notes ref, release materials and hostname. Review, authorize and publish the exact artifact. | Pilot work may continue, but cannot alter the release candidate. | Canonical host and legacy-link smoke checks pass. Demonstrate automatic delivery from a Portfolio push and a verified Notes update, and record rollback evidence. Propose Notes N7 cleanup separately. |
| **5. Connect the pilot reader** | Notes N3 and N4 supply reviewed pilot fixtures and trace evidence. Portfolio Tasks 8 and 9 add canonical numeric lessons, static transcripts, accessible playback and Pagefind scoping, then public study trees. | Lesson authoring and Portfolio renderer work can overlap after the fixture contract is fixed. | All eight pilots pass execution and teaching review. Connected Chromium verifies real staged pages, keyboard/touch/reduced motion, trace verification and draft exclusion. Publish reviewed pilots via Notes N4 and the approved CI path. |
| **6. Private progress** | Portfolio Task 10 adds owner-only Access, Worker/D1, stable lesson progress, phone/computer sync and export under the Portfolio plan. | May run independently after phase 5 confirms lesson identities and route behavior. It does not gate phases 4, 5 or 7. | Direct unauthorized API access fails. Owner progress syncs across devices and stays outside public output. |
| **7. Curriculum waves** | Notes N5 reconciles all remaining identities and writes, runs, reviews and publishes the full catalog in waves. Notes N6 performs final acceptance. | Identity intake may start earlier once N3 fixes its evidence rules. Production batches begin after pilot approval even while private progress is in flight. | Exact coverage of IDs 1–2000, every lesson verified, no unresolved gaps, routes and global publishing limits pass. |

### Handoffs and release decisions

1. Portfolio Task 0 and Notes N0 share one baseline inventory. Use the exact handoff checksum file identified in Portfolio Task 0. The historical October 4 website and October 21 information architecture documents describe the completed baseline. The October 24 documents have supersession notices.
2. Notes N1 owns the snapshot contract, fixture and real export. Portfolio Task 2 names that handoff. Task 3 demonstrates acceptance of the pinned real export. N2 source-edit verification belongs in phase 2. Run required CI on pull requests in each repo from the first implementation PR. Simulate the Notes notification in phase 2 and activate production delivery at the authorized phase 4 cutover.
3. Phase 3 qualifies the combined build. Phase 4 records approval and the actual launch. Delayed domain, content or deployment approval holds public launch. Isolated pilot authoring and browser acceptance can continue against the qualified build.
4. Phase 5 first stages eight draft lessons privately, then checks the same reviewed content after Notes promotion in a production-mode build. The public reader and trace assets must both pass. Record deployment separately from content verification.
5. Phases 6 and 7 are parallel successors to the pilot gate. Notes N7 is optional after a verified live cutover and cleanup approval. Neither private progress nor cleanup blocks curriculum batches.

### Status and ownership

Record each gate once with repository SHAs, verification, review and release evidence. Use explicit counts for planned, drafted and verified lessons. Baseline is one reviewed Two Sum draft, 1,999 planned targets and zero verified lessons. Notes owns lesson promotions. Portfolio controls what the site shows from each verified snapshot. No deployment or external write is implied by marking a plan step complete.

### Historical Notes document index

Paths below are relative to the Notes repository. For the exact historical inputs, read them at the engineering baseline SHA above. The three October 24 notices point forward to the November plans.

| Status | Spec or plan |
| --- | --- |
| Completed baseline | `docs/superpowers/specs/2026-10-04-notes-website-design.md` |
| Completed baseline | `docs/superpowers/plans/2026-10-04-notes-website.md` |
| Completed baseline | `docs/superpowers/specs/2026-10-21-library-information-architecture-design.md` |
| Completed baseline | `docs/superpowers/plans/2026-10-21-library-information-architecture.md` |
| Superseded | `docs/superpowers/specs/2026-10-24-leetcode-learning-library-design.md` |
| Superseded | `docs/superpowers/plans/2026-10-24-leetcode-learning-platform.md` |
| Superseded | `docs/superpowers/plans/2026-10-24-leetcode-curriculum.md` |
