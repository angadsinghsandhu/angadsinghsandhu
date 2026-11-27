import { expect, test } from "vitest";
import { assertTraceMatchesLesson } from "../../../src/client/practice/player.js";
import type { AlgorithmTrace } from "../../../src/client/practice/trace-model.js";

const step = {
  stepId: "check",
  explanation: "Check the first value.",
  codeLines: [1, 2],
};
const trace: AlgorithmTrace = {
  version: 1,
  problemId: "leetcode:127",
  approachId: "bfs",
  implementationSha256: "a".repeat(64),
  exampleId: "example",
  result: null,
  frames: [
    { ...step, state: { kind: "queue", items: ["hit"] }, highlights: [] },
  ],
};
const expected = {
  problemId: trace.problemId,
  approachId: trace.approachId,
  implementationSha256: trace.implementationSha256,
  transcripts: [{ exampleId: trace.exampleId, steps: [step] }],
};

test("matches the complete published transcript and available code lines", () => {
  expect(() =>
    assertTraceMatchesLesson([trace], expected, new Set([1, 2])),
  ).not.toThrow();
  expect(() =>
    assertTraceMatchesLesson([trace], expected, new Set([1])),
  ).toThrow(/code line/i);
});

test.each([
  { problemId: "leetcode:1" as const },
  { approachId: "another" },
  { implementationSha256: "b".repeat(64) },
  { frames: [] },
  { frames: [{ ...trace.frames[0]!, stepId: "wrong" }] },
  { frames: [{ ...trace.frames[0]!, explanation: "Wrong" }] },
  { frames: [{ ...trace.frames[0]!, codeLines: [2, 1] }] },
])(
  "rejects a packaged trace that differs from the published lesson",
  (change) => {
    expect(() =>
      assertTraceMatchesLesson(
        [{ ...trace, ...change }],
        expected,
        new Set([1, 2]),
      ),
    ).toThrow(/transcript/i);
  },
);
