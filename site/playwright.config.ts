import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:4389";
const fixturesURL = "http://127.0.0.1:4390";
const preview = process.env.PORTFOLIO_PAIRED_PREVIEW_DIR
  ? `node --input-type=module -e 'import { preview } from "astro"; await preview({ outDir: process.env.PORTFOLIO_PAIRED_PREVIEW_DIR, server: { host: "127.0.0.1", port: 4389 } });'`
  : "npm run preview -- --ignore-lock --host 127.0.0.1 --port 4389";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  use: { baseURL, channel: "chromium" },
  webServer: [
    {
      command: preview,
      url: baseURL,
    },
    {
      command:
        "npm run dev -- --ignore-lock --mode fixtures --host 127.0.0.1 --port 4390",
      url: fixturesURL,
    },
  ],
});
