# Portfolio and Notes migration baseline

## Portfolio

The legacy portfolio is recoverable from commit `9357c9fe2a252594029045044f3f73e12af18d06`. Keep the profile `README.md` at blob `d029d6a19219b56676a8fc6057c6e5600e2d895c`.

| Legacy URL or anchor | Shell disposition |
| --- | --- |
| `/`, `/index.html`, `#hero`, `#about` | Home. Keep the index URL and these fragment targets. |
| `/#resume`, `/#portfolio` | Keep direct fragment targets and link to the résumé and Projects indexes. |
| `/#contact` | Keep the anchor and use existing public profile links. The demo form addresses a placeholder recipient. |
| `/portfolio-details.html` | The nine demo cards share this path. Keep it reachable and direct visitors to Projects. |
| `#header`, `#navbar`, `#main`, `#facts`, `#skills`, `#portfolio-flters`, `#services`, `#testimonials`, `#name`, `#email`, `#subject`, `#footer`, `#preloader` | Template internals or demo content. Retain the source in Git history. |

The 106 legacy files under `site/` include BootstrapMade template code, libraries, gallery and testimonial images, the contact demo and a profile GIF. Retain the full tree in Git history. Use the approved wireframe artwork for the new home. Reuse the profile GIF only if its provenance and publication approval are confirmed. The legacy social controls are placeholders. The preserved profile lists LinkedIn, Medium, Twitter and Buy Me a Coffee.

## Notes

Use `fc304f38e9757064537c094a4fb71c6447946920` for engineering compatibility in a separate checkout. The archived roots are identical to `ae63925c5ee7d77543e2c027b62d69c29a8d22ab`, the current Notes organization acceptance branch. That branch contains the supersession notices from #50. Notes PRs #39–48 remain an open stack targeting `master` through successive branches. Draft #49 targets the organization acceptance branch. The engineering commit supplies the reviewed archive and committed curriculum preparation for the snapshot proof. Review the production publication ref and the required committed changes separately before merging Notes work. All nine parked worktree paths matched the handoff SHA-256 checksums.

| Verified local build inventory | Count |
| --- | ---: |
| Canonical reader routes | 6,279 |
| Reader aliases declared in the manifest | 0 |
| Distinct reader route and fragment pairs | 3,487 |
| Original source records | 10,031 |
| Source records by disposition | 6,279 page, 2,354 supporting asset, 1,319 unsupported, 79 excluded |
| Registered assets | 318, including 308 local |
| Static HTML pages including navigation and catalog views | 9,017 |
| Indexed pages | 6,279 |
| Deployment files including Pagefind | 16,018 |
| Deployment bytes | 1,028,581,154 |
| Largest file | 21,722,117 bytes, PDF |

Rebuild with Node 24.18.1, Python 3.12.14, pinned requirements, full Chromium, an HTTPS `SITE_URL` and the full `SOURCE_REVISION`. The initial local `npm run build` completed on the exact checkout. It checked file limits, routes, assets, fragments, source actions and search. The original [Notes CI run](https://github.com/angadsinghsandhu/Notes/actions/runs/45095454315) passed on the reviewed PR, with 940 unit and 119 browser tests. Compare route and anchor sets from `site/.generated/current/manifest.json` against the combined Portfolio output. Phase 3 owns the comparison and requires explicit review of any differences.

[Oversized Notes files at the engineering baseline](notes-baseline-oversized.tsv) records exact paths, Git blob IDs and physical line counts. A test directory alone does not exempt an ordinary fixture or helper. The Notes line gate will distinguish byte-identical legacy text from added, moved or edited files.
