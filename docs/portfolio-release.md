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
