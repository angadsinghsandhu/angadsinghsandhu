import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { stagePdfAssets } from "./scripts/pdf-assets.ts";

const origin = process.env.PORTFOLIO_ORIGIN;
if (process.env.PORTFOLIO_NOTES_BUILD_RECEIPT && !origin)
  throw new Error("Set PORTFOLIO_ORIGIN for a combined Notes build");
if (origin) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.href !== `${url.origin}/` ||
    url.username ||
    url.password
  )
    throw new Error("PORTFOLIO_ORIGIN must be an HTTPS origin");
}

export default defineConfig({
  ...(origin ? { site: origin } : {}),
  output: "static",
  trailingSlash: "always",
  integrations: [
    {
      name: "portfolio-fixtures",
      hooks: {
        "astro:config:setup": ({ command, updateConfig }) => {
          updateConfig({
            vite: { define: { __PORTFOLIO_DEV__: command === "dev" } },
          });
        },
      },
    },
    {
      name: "portfolio-notes-assets",
      hooks: {
        "astro:build:done": async ({ dir, pages }) => {
          if (!process.env.PORTFOLIO_NOTES_BUILD_RECEIPT) return;
          const out = fileURLToPath(dir);
          if (process.env.PORTFOLIO_NOTES_LOCAL_PDF === "1")
            await stagePdfAssets(join(out, "pdfjs"));
          if (
            !pages.some(({ pathname }) =>
              /^(?:notes|resources)\//u.test(pathname),
            )
          )
            return;
          execFileSync(resolve("node_modules/.bin/pagefind"), ["--site", out], {
            stdio: "inherit",
          });
          const licenses = join(out, "licenses");
          await mkdir(licenses, { recursive: true });
          await Promise.all(
            [
              ["katex/LICENSE", "katex.txt"],
              ["pagefind/LICENSE/LICENSE", "pagefind.txt"],
              [
                "pagefind/LICENSE/LICENSE-vscode-ripgrep",
                "pagefind-vscode-ripgrep.txt",
              ],
            ].map(([source, target]) =>
              copyFile(
                resolve("node_modules", source),
                join(licenses, target),
                constants.COPYFILE_EXCL,
              ),
            ),
          );
        },
      },
    },
  ],
});
