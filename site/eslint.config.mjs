import js from "@eslint/js";
import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";
import { boundaryRules, ignores } from "./eslint.boundaries.config.mjs";

export default [
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...boundaryRules,
  {
    files: ["*.mjs", "{scripts,tests}/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
      },
    },
  },
];
