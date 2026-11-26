const pagesStaticLimit = 2_000;
const pagesDeclarationLimit = 1_000;
const textLineLimit = 500;
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const xmlNamespace = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

export function renderNotesRedirects(aliases: ReadonlyMap<string, string>) {
  if (aliases.size > pagesStaticLimit)
    throw new Error(
      `Notes redirects exceed the Pages ${pagesStaticLimit} static-rule limit`,
    );
  if (aliases.size > textLineLimit)
    throw new Error(`Notes redirects exceed the ${textLineLimit}-line limit`);
  return [...aliases.keys()]
    .sort()
    .map((alias) => {
      const target = aliases.get(alias)!;
      if (
        !/^\/(?:[a-zA-Z0-9_.%_-]+\/)*[a-zA-Z0-9_.%_-]+\/?$/u.test(alias) ||
        !/^\/(?:[a-z0-9-]+\/)+$/u.test(target) ||
        /[:*?#\\]/u.test(decodeURIComponent(alias)) ||
        /^\/sitemap(?:-\d+)?\.xml\/?$/iu.test(decodeURIComponent(alias))
      )
        throw new Error(`Cannot render Notes redirect: ${alias} → ${target}`);
      const declaration = `${alias} ${target} 308`;
      if (declaration.length > pagesDeclarationLimit)
        throw new Error(
          `Notes redirect exceeds the Pages ${pagesDeclarationLimit}-character limit: ${alias}`,
        );
      return declaration + "\n";
    })
    .join("");
}

export function outputOrigin(input: string | undefined): string {
  const url = input && URL.parse(input);
  if (!url || url.protocol !== "https:" || url.href !== `${url.origin}/`)
    throw new Error("Set PORTFOLIO_ORIGIN to the expected HTTPS origin");
  return url.origin;
}

function xml(kind: "urlset" | "sitemapindex", urls: string[]) {
  const entry = kind === "urlset" ? "url" : "sitemap";
  return [
    xmlHeader,
    `<${kind} ${xmlNamespace}>`,
    ...urls.map(
      (url) =>
        `<${entry}><loc>${url.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</loc></${entry}>`,
    ),
    `</${kind}>`,
    "",
  ].join("\n");
}

export function renderSitemap(origin: string, urls: Iterable<string>) {
  const perPart = textLineLimit - 3;
  const ordered = [...urls].sort();
  if (ordered.length <= perPart)
    return new Map([["sitemap.xml", xml("urlset", ordered)]]);
  const parts = new Map<string, string>();
  for (let start = 0; start < ordered.length; start += perPart)
    parts.set(
      `sitemap-${parts.size + 1}.xml`,
      xml("urlset", ordered.slice(start, start + perPart)),
    );
  return new Map([
    [
      "sitemap.xml",
      xml(
        "sitemapindex",
        [...parts.keys()].map((path) => new URL(path, origin).href),
      ),
    ],
    ...parts,
  ]);
}
