import { builtinModules } from "node:module";
import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export const ignores = [
  "dist/**",
  ".astro/**",
  ".generated/**",
  ".install-*/**",
  ".vite/**",
  ".browsers/**",
  "public/**",
  "playwright-report/**",
  "test-results/**",
];

const privateBuildModules = String.raw`(^|/)(scripts|\.generated)(/|$)`;
const filesystem = "^(node:)?fs(/|$)";
const nodeModules = `^node:|^(?:${builtinModules.filter((name) => !name.startsWith("node:")).join("|")})$`;
const serverNotes = String.raw`(^|/)notes-(catalog|snapshot|routes)(\.[cm]?[jt]s)?$`;

function restrictImports(regex, message) {
  const restrictedSource = regex.replaceAll("/", "\\/");

  return {
    "no-restricted-imports": ["error", { patterns: [{ regex, message }] }],
    "no-restricted-syntax": [
      "error",
      {
        selector: `ImportExpression[source.value=/${restrictedSource}/]`,
        message,
      },
      {
        selector: `ImportExpression > TemplateLiteral.source[expressions.length=0] > TemplateElement[value.cooked=/${restrictedSource}/]`,
        message,
      },
      {
        selector: `TSImportType[source.value=/${restrictedSource}/]`,
        message,
      },
    ],
  };
}

export const boundaryRules = [
  {
    files: ["src/{pages,layouts,components}/**/*.{astro,ts,js,mjs}"],
    rules: restrictImports(
      `${privateBuildModules}|${filesystem}`,
      "Render prepared data through the catalog.",
    ),
  },
  {
    files: ["src/client/**/*.{ts,js,mjs}", "src/**/*.astro/*.{ts,js}"],
    rules: restrictImports(
      `${privateBuildModules}|${nodeModules}|${serverNotes}`,
      "Browser code must use browser-safe modules.",
    ),
  },
];

export default [
  { ignores },
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
  ...astro.configs.base,
  ...boundaryRules,
];
