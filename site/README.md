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

Run the import from `site/` using the reviewed Notes export directory, its full Git revision and the matching exporter receipt obtained through the handoff.

```sh
npm run import:notes -- --from /path/to/export --revision <sha> --receipt /path/to/receipt.json
npm run build:release
```

The receipt binds the export mode, source revision and manifest SHA-256. The importer verifies the exact file tree and both asset inventories before atomically switching `.generated/notes/current.json`. A failed or interrupted import leaves the previous verified generation available. Identical imports reuse the same generation.

`npm run build` still builds the shell independently. The release command requires a verified production import and adds only its Pages allowlist to `dist/content-assets/`. Worker packages, the manifest and preview fixtures stay outside the output. The Notes reader routes are added in the next integration task.

`readNotesSnapshot(dir, expectedSha)` reads the active generation from `dir` and returns the verified manifest with separate Pages and Worker file lists. Use `.generated/notes` for `dir` from `site/`.

The versioned schema and preview fixture are copied byte-for-byte from Notes revision `ed3a31f261f25f03ff9be0fe5f5d91d13e45c093`.

## Dependency lock

`dependency-lock/` holds the complete npm lock metadata in readable shards. The bootstrap command reconstructs the standard lock and runs `npm ci` in a disposable directory.

To update dependencies, edit `package.json`. Generate the next lock with `npm install --package-lock-only` in a disposable directory containing the updated manifest and the existing assembled lock. Reassemble it with `readLock` and `lockJson` from `scripts/lock.mjs`. Run `node scripts/lock.mjs path/to/package-lock.json path/to/new-shards`, review the changes and replace the generated shards. Confirm a fresh bootstrap before committing.
