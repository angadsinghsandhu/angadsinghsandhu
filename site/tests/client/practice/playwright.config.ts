import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "player.spec.ts",
  use: { channel: "chromium" },
});
