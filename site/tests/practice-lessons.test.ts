import { expect, it } from "vitest";
import {
  createPracticeLessonPaths,
  numberPracticeCodeLines,
  preparePracticeProse,
} from "../src/lib/practice-lessons";
import { portfolioSnapshotV1 } from "../src/lib/notes-snapshot-v1";
import fixture from "./fixtures/notes-snapshot/manifest.v1.json";

it("emits no numeric route for the empty verified curriculum", () => {
  expect(createPracticeLessonPaths()).toEqual([]);
  expect(createPracticeLessonPaths(portfolioSnapshotV1.parse(fixture))).toEqual(
    [],
  );
});

it("joins the eligible lesson, problem, and its original source at the numeric route", () => {
  const manifest = portfolioSnapshotV1.parse(fixture);
  const source = manifest.entries[0]!;
  const problem = {
    id: "leetcode:1",
    number: 1,
    title: "Two Sum",
    slug: "two-sum",
    status: "verified",
    difficulty: "easy",
    domain: "algorithm",
    officialUrl: "https://leetcode.com/problems/two-sum/",
    officialQuestionObservedOn: "2026-11-23",
    companies: [],
    topics: ["array"],
  } as const;
  const lesson = {
    problemId: problem.id,
    status: "verified",
    route: "/practice/leetcode/1/",
    bodyHtml: "<p>Find the two matching indices.</p>",
    headings: [],
    approaches: [],
  } as const;
  manifest.verifiedCurriculumIds = [1];
  manifest.curriculum = {
    ...manifest.curriculum,
    generation: "a".repeat(64),
    problems: [{ ...problem, companies: [], topics: ["array"] }],
    lessons: [{ ...lesson, approaches: [], headings: [] }],
    sourceVariants: [
      {
        problemId: problem.id,
        sourceId: source.id,
        sourceRoute: source.route,
        lessonRoute: lesson.route,
      },
    ],
  };
  expect(
    createPracticeLessonPaths(portfolioSnapshotV1.parse(manifest)),
  ).toEqual([
    {
      params: { number: "1" },
      props: {
        problem,
        lesson,
        sources: [{ title: source.title, route: source.sourceUrl }],
      },
    },
  ]);
});

it("preserves highlighted source and numbers each Shiki line once", () => {
  const html =
    '<pre class="shiki github-dark" tabindex="0"><code><span class="line"><span style="color:#F97583">return</span> x &lt; y</span>\n<span class="line"></span></code></pre>';
  expect(numberPracticeCodeLines(html, "example")).toBe(
    '<pre class="shiki github-dark"><code><span class="line" id="example-line-1" data-practice-line="1"><span style="color:#F97583">return</span> x &#x3C; y</span>\n<span class="line" id="example-line-2" data-practice-line="2"></span></code></pre>',
  );
});

it("puts the author title anchor on the page title and labels overflow regions", () => {
  const result = preparePracticeProse(
    '<h1 id="two-sum">Two Sum</h1><p>Find the indices.</p><pre tabindex="0"><code>x</code></pre>',
    [
      { id: "two-sum", text: "Two Sum", depth: 1 },
      { id: "approaches", text: "Approaches", depth: 2 },
    ],
    "Two Sum",
  );
  expect(result).toEqual({
    titleId: "two-sum",
    headings: [{ id: "approaches", text: "Approaches", depth: 2 }],
    html: '<p>Find the indices.</p><div class="scroll-region" role="region" aria-label="Code" tabindex="0"><pre><code>x</code></pre></div>',
  });
});
