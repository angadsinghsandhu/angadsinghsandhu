import { defineConfig } from "astro/config";

export default defineConfig({
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
  ],
});
