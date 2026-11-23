# Portfolio site

Use Node 24.18.1 and run these commands from `site/`.

```sh
npm run bootstrap
npx playwright install chromium
npm run verify
```

`npm run dev` starts the public shell. `npm run verify` checks formatting, physical line limits, Astro types, unit tests, the static build and Chromium navigation. The browser suite uses port 4389 for the built site and 4390 for its isolated fixture server.

## Editorial content

Add reviewed copy and entries to `src/content/editorial.ts`. Only approved projects and music releases get detail URLs. Keep entries in draft until their linked materials are ready. To publish the résumé, populate the web résumé and place the approved PDF in `public/resume.pdf` so the download URL stays `/resume.pdf`.

Run `npm run dev -- --mode fixtures` to see the synthetic project and music release. A normal dev server and the static build omit their routes and assets.

## Notes snapshot

Import a reviewed Notes export directory with its full Git revision and exporter receipt. Set the HTTPS origin for the combined build. Use a nonproduction origin for local acceptance.

```sh
npm run import:notes -- --from /path/to/export --revision "$NOTES_REVISION" --receipt /path/to/receipt.json
PORTFOLIO_ORIGIN=https://portfolio-preview.example npm run build:release
PORTFOLIO_NOTES_BROWSER=archive npx playwright test tests/notes-reader.spec.ts
```

The importer verifies the receipt, revision, file tree and assets before switching `.generated/notes/current.json`. Combined builds pin that verified generation for both rendering and asset copying. A failed or interrupted import leaves the previous generation available.

`npm run build` builds the shell independently. The release command requires a production export. Its `dist/` includes canonical reader pages, aliases, a Pagefind index, local PDF support and only the snapshot's approved Pages assets. The manifest and Worker packages stay in the private build workspace.

For a preview export, build and serve a separate output directory.

```sh
PORTFOLIO_ORIGIN=https://portfolio-preview.example npm run build:notes-preview -- "$NOTES_REVISION"
npm run preview -- --ignore-lock --outDir .generated/notes-preview --port 4391
```

The versioned schema and preview fixture are copied byte-for-byte from Notes revision `ed3a31f261f25f03ff9be0fe5f5d91d13e45c093`.

## Dependency lock

`dependency-lock/` holds the complete npm lock metadata in readable shards. The bootstrap command reconstructs the standard lock and runs `npm ci` in a disposable directory.

To update dependencies, edit `package.json`. Generate the next lock with `npm install --package-lock-only` in a disposable directory containing the updated manifest and the existing assembled lock. Reassemble it with `readLock` and `lockJson` from `scripts/lock.mjs`. Run `node scripts/lock.mjs path/to/package-lock.json path/to/new-shards`, review the changes and replace the generated shards. Confirm a fresh bootstrap before committing.
