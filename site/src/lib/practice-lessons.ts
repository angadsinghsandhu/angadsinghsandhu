import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import type { Element, Root } from "hast";
import type { PortfolioSnapshotV1 } from "./notes-snapshot-v1";

type PracticeCurriculum = PortfolioSnapshotV1["curriculum"];
type PracticeLesson = PracticeCurriculum["lessons"][number];
type PracticeProblem = PracticeCurriculum["problems"][number];
export type PracticeApproach = PracticeLesson["approaches"][number];

export type PracticeLessonProps = {
  problem: PracticeProblem;
  lesson: PracticeLesson;
  sources: { title: string; route: string }[];
};

export function createPracticeLessonPaths(manifest?: PortfolioSnapshotV1) {
  if (!manifest) return [];
  const { problems, lessons, sourceVariants } = manifest.curriculum;
  const verified = new Set(manifest.verifiedCurriculumIds);
  const problemsById = new Map(
    problems
      .filter(({ number }) => verified.has(number))
      .map((problem) => [problem.id, problem]),
  );
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const sourcesById = new Map<string, PracticeLessonProps["sources"]>();
  for (const variant of sourceVariants) {
    const entry = entries.get(variant.sourceId);
    if (!entry) continue;
    const sources = sourcesById.get(variant.problemId) ?? [];
    sources.push({
      title: entry.title,
      route: entry.sourceUrl ?? entry.assetUrl ?? variant.sourceRoute,
    });
    sourcesById.set(variant.problemId, sources);
  }
  return lessons.flatMap((lesson) => {
    const problem = problemsById.get(lesson.problemId);
    if (!problem) return [];
    const props: PracticeLessonProps = {
      lesson,
      problem,
      sources: sourcesById.get(lesson.problemId) ?? [],
    };
    return [{ params: { number: String(problem.number) }, props }];
  });
}

export function numberPracticeCodeLines(html: string, approachId: string) {
  const tree = fromHtml(html, { fragment: true });
  let line = 0;
  function numberLines(node: Root | Element) {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "pre") delete child.properties.tabIndex;
      if (
        child.tagName === "span" &&
        Array.isArray(child.properties.className) &&
        child.properties.className.includes("line")
      ) {
        line++;
        child.properties.id = `${approachId}-line-${line}`;
        child.properties.dataPracticeLine = line;
      } else {
        numberLines(child);
      }
    }
  }
  numberLines(tree);
  return toHtml(tree);
}

export function preparePracticeProse(
  html: string,
  headings: PracticeLesson["headings"],
  title: string,
) {
  const tree = fromHtml(html, { fragment: true });
  const first = tree.children.find((child) => child.type === "element");
  const titleId = headings.find(
    ({ depth, id, text }) =>
      depth === 1 &&
      text === title &&
      first?.tagName === "h1" &&
      first.properties.id === id,
  )?.id;
  if (titleId) tree.children = tree.children.filter((child) => child !== first);

  function wrapOverflow(node: Root | Element): void {
    node.children = node.children.map((child) => {
      if (child.type !== "element") return child;
      wrapOverflow(child);
      const { tagName, properties } = child;
      const math =
        Array.isArray(properties.className) &&
        properties.className.includes("katex-display");
      const label =
        tagName === "pre"
          ? "Code"
          : tagName === "table"
            ? "Data table"
            : math
              ? "Mathematical formula"
              : undefined;
      if (!label) return child;
      if (tagName === "pre") delete properties.tabIndex;
      return {
        type: "element",
        tagName: "div",
        properties: {
          className: ["scroll-region", ...(math ? ["math-scroll"] : [])],
          role: "region",
          ariaLabel: label,
          tabIndex: 0,
        },
        children: [child],
      } satisfies Element;
    });
  }
  wrapOverflow(tree);

  return {
    html: toHtml(tree),
    headings: headings.filter(({ id }) => titleId !== id),
    titleId,
  };
}
