import { describe, expect, it } from "vitest";
import {
  createPracticeDiscovery,
  nextPracticeProblem,
} from "../src/lib/practice-discovery";
import type { PortfolioSnapshotV1 } from "../src/lib/notes-snapshot-v1";

type Curriculum = PortfolioSnapshotV1["curriculum"];
type Node = Curriculum["paths"][number]["nodes"][number];

const stage = (
  id: string,
  childIds: string[],
  prerequisiteIds: string[] = [],
): Node => ({
  kind: "stage",
  id,
  title: id,
  childIds,
  prerequisiteIds,
});
const target = (
  id: string,
  number: number,
  prerequisiteIds: string[] = [],
): Node => ({
  kind: "problem",
  id,
  problemId: `leetcode:${number}`,
  childIds: [],
  prerequisiteIds,
});

function fixture(rootIds: string[], nodes: Node[], id = "sequence") {
  const problems: Curriculum["problems"] = [1, 2, 3].map((number) => ({
    id: `leetcode:${number}`,
    number,
    status: "verified",
    title: `Target ${number}`,
    slug: `target-${number}`,
    officialUrl: `https://leetcode.com/problems/target-${number}/`,
    domain: "algorithm",
    difficulty: "easy",
    topics: [],
    officialQuestionObservedOn: "2026-11-23",
    companies: [],
  }));
  return {
    verifiedCurriculumIds: [1, 2],
    curriculum: {
      generation: "a".repeat(64),
      paths: [
        { id, title: "Path", description: "Study sequence", rootIds, nodes },
      ],
      pendingPathLabels: nodes.flatMap((node) =>
        node.kind === "problem" && node.problemId === "leetcode:4"
          ? [
              {
                pathId: id,
                nodeId: node.id,
                problemId: node.problemId,
                title: "Pending four",
              },
            ]
          : [],
      ),
      problems,
      lessons: problems.map(({ id, number }) => ({
        problemId: id,
        route: `/practice/leetcode/${number}/`,
        status: "verified" as const,
        bodyHtml: "Lesson body",
        approaches: [],
        headings: [],
      })),
      traceAssets: [],
      sourceVariants: [],
    },
  };
}

describe("practice discovery", () => {
  it("lists only eligible numeric lessons and marks pending targets without links", () => {
    const discovery = createPracticeDiscovery(
      fixture(
        ["x", "y", "z"],
        [target("x", 2), target("y", 3), target("z", 4)],
      ),
    );
    expect(discovery.problems.map(({ id, route }) => [id, route])).toEqual([
      ["leetcode:1", "/practice/leetcode/1/"],
      ["leetcode:2", "/practice/leetcode/2/"],
    ]);
    const path = discovery.paths[0]!;
    expect(
      path.outline.map(({ id, title, route }) => [id, title, route]),
    ).toEqual([
      ["leetcode:2", "Target 2", "/practice/leetcode/2/"],
      ["leetcode:3", "Problem 3", undefined],
      ["leetcode:4", "Pending four", undefined],
    ]);
    expect(path.available).toBe(1);
    expect(nextPracticeProblem(path)).toMatchObject({ id: "leetcode:2" });
  });

  it("keeps repeated references, deduplicates the outline, and recommends in eligible branch order", () => {
    const path = createPracticeDiscovery(
      fixture(
        ["advanced", "basic", "review"],
        [
          stage("advanced", ["shared"], ["basic"]),
          target("basic", 2),
          stage("review", ["shared", "also-shared"]),
          target("shared", 1),
          target("also-shared", 1),
        ],
      ),
    ).paths[0]!;
    expect(path.nodes.get("advanced")?.childIds).toEqual(["shared"]);
    expect(path.nodes.get("review")?.childIds).toEqual([
      "shared",
      "also-shared",
    ]);
    expect(path.outline.map(({ id }) => id)).toEqual([
      "leetcode:1",
      "leetcode:2",
    ]);
    expect(path.available).toBe(2);
    expect(nextPracticeProblem(path)?.id).toBe("leetcode:2");
    expect(nextPracticeProblem(path, new Set(["leetcode:2"]))?.id).toBe(
      "leetcode:1",
    );
    expect(
      nextPracticeProblem(path, new Set(["leetcode:1", "leetcode:2"])),
    ).toBeUndefined();
  });

  it("waits when every verified target depends on a pending prerequisite", () => {
    const path = createPracticeDiscovery(
      fixture(
        ["pending", "verified"],
        [target("pending", 4), target("verified", 1, ["pending"])],
      ),
    ).paths[0]!;
    expect(path.available).toBe(1);
    expect(nextPracticeProblem(path)).toBeUndefined();
  });

  it.each([
    [["missing"], [target("a", 1)], /missing/],
    [
      ["a"],
      [stage("a", ["b"]), target("b", 1, ["a"]), target("c", 2)],
      /unreachable/,
    ],
    [["a"], [stage("a", ["b"], ["b"]), target("b", 1)], /cycle/],
    [["a", "a"], [target("a", 1)], /duplicate/],
  ] as const)("fails closed on invalid graphs %#", (roots, nodes, error) => {
    expect(() =>
      createPracticeDiscovery(fixture([...roots], [...nodes])),
    ).toThrow(error);
  });

  it("requires all 2,000 sequential identities and rejects a same-count substitution", () => {
    const nodes = Array.from({ length: 2_000 }, (_, position) =>
      target(`target-${position + 1}`, position + 1),
    );
    const roots = nodes.map(({ id }) => id);
    const good = createPracticeDiscovery(fixture(roots, nodes, "all-problems"));
    expect(good.paths[0]?.outline).toHaveLength(2_000);
    nodes[1_999] = target("target-2000", 2_001);
    expect(() =>
      createPracticeDiscovery(fixture(roots, nodes, "all-problems")),
    ).toThrow(/coverage/);
  });
});
