import { readPreparedNotesManifest } from "./notes-catalog.ts";
import type { PortfolioSnapshotV1 } from "./notes-snapshot-v1.ts";

type Curriculum = PortfolioSnapshotV1["curriculum"];
type Path = Curriculum["paths"][number];
type Node = Path["nodes"][number];

export type PracticeResult = Curriculum["problems"][number] & { route: string };
type PathTarget = {
  id: string;
  number: number;
  title: string;
  route?: string;
};
type PathNode = Node & { label: string; target?: PathTarget };
export type PracticeStudyPath = Pick<
  Path,
  "id" | "title" | "description" | "rootIds"
> & {
  nodes: ReadonlyMap<string, PathNode>;
  firstParent: ReadonlyMap<string, string | undefined>;
  dependencyOrder: string[];
  outline: PathTarget[];
  available: number;
};

function pathOrder(
  nodes: ReadonlyMap<string, PathNode>,
  rootIds: string[],
  eligible?: ReadonlySet<string>,
) {
  const order = new Map<string, string | undefined>();
  const pending = rootIds
    .toReversed()
    .map((id) => ({ id, parent: undefined as string | undefined }));
  for (let item = pending.pop(); item; item = pending.pop()) {
    const { id, parent } = item;
    if (order.has(id) || (eligible && !eligible.has(id))) continue;
    order.set(id, parent);
    for (const child of nodes.get(id)!.childIds.toReversed()) {
      pending.push({ id: child, parent: id });
    }
  }
  return order;
}

function dependencyOrder(path: Path, nodes: ReadonlyMap<string, PathNode>) {
  const dependents = new Map(
    [...nodes.keys()].map((id) => [id, [] as string[]]),
  );
  const incoming = new Map([...nodes.keys()].map((id) => [id, 0]));

  function requireReferences(ids: string[], kind: string) {
    if (new Set(ids).size !== ids.length)
      throw new Error(`Path ${path.id}: duplicate ${kind} reference`);
    for (const id of ids) {
      if (!nodes.has(id))
        throw new Error(`Path ${path.id}: missing ${kind} node ${id}`);
    }
  }

  function connect(before: string, after: string) {
    dependents.get(before)!.push(after);
    incoming.set(after, incoming.get(after)! + 1);
  }

  requireReferences(path.rootIds, "root");
  for (const { id, childIds, prerequisiteIds } of nodes.values()) {
    requireReferences(childIds, "child");
    requireReferences(prerequisiteIds, "prerequisite");
    for (const child of childIds) connect(id, child);
    for (const prerequisite of prerequisiteIds) connect(prerequisite, id);
  }

  const ordered = [...nodes.keys()].filter((id) => incoming.get(id) === 0);
  for (const id of ordered) {
    for (const dependent of dependents.get(id)!) {
      const remaining = incoming.get(dependent)! - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) ordered.push(dependent);
    }
  }
  if (ordered.length !== nodes.size)
    throw new Error(`Path ${path.id}: cycle in hierarchy or prerequisites`);
  return ordered;
}

function createStudyPath(
  path: Path,
  eligible: ReadonlyMap<string, PracticeResult>,
  pendingLabels?: ReadonlyMap<string, string>,
): PracticeStudyPath {
  const nodes = new Map<string, PathNode>();
  for (const node of path.nodes) {
    if (nodes.has(node.id))
      throw new Error(`Path ${path.id}: duplicate node ${node.id}`);
    if (node.kind === "stage") {
      nodes.set(node.id, { ...node, label: node.title });
      continue;
    }
    const problem = eligible.get(node.problemId);
    const number = Number(node.problemId.slice("leetcode:".length));
    const title =
      problem?.title ?? pendingLabels?.get(node.id) ?? `Problem ${number}`;
    const target = {
      id: node.problemId,
      title,
      number,
      ...(problem ? { route: problem.route } : {}),
    };
    nodes.set(node.id, { ...node, label: title, target });
  }
  const ordered = dependencyOrder(path, nodes);
  const firstParent = pathOrder(nodes, path.rootIds);
  if (firstParent.size !== nodes.size)
    throw new Error(`Path ${path.id}: unreachable nodes in hierarchy`);
  const targets = new Map<string, PathTarget>();
  for (const id of firstParent.keys()) {
    const target = nodes.get(id)!.target;
    if (target && !targets.has(target.id)) targets.set(target.id, target);
  }
  if (
    path.id === "all-problems" &&
    (targets.size !== 2_000 ||
      Array.from(
        { length: 2_000 },
        (_, offset) => `leetcode:${offset + 1}`,
      ).some((id) => !targets.has(id)))
  )
    throw new Error(`Path ${path.id}: invalid coverage of 2,000 targets`);
  const outline = [...targets.values()];
  return {
    id: path.id,
    title: path.title,
    description: path.description,
    rootIds: path.rootIds,
    nodes,
    firstParent,
    dependencyOrder: ordered,
    outline,
    available: outline.filter(({ route }) => route).length,
  };
}

export function nextPracticeProblem(
  path: PracticeStudyPath,
  studied: ReadonlySet<string> = new Set(),
) {
  // A shared node can be reached through any branch whose prerequisites are met.
  const satisfied = new Set<string>();
  const ready = new Set<string>();
  const reachable = new Set(path.rootIds);
  for (const id of path.dependencyOrder) {
    const { childIds, prerequisiteIds, target } = path.nodes.get(id)!;
    if (
      !reachable.has(id) ||
      !prerequisiteIds.every((ref) => satisfied.has(ref))
    )
      continue;
    ready.add(id);
    for (const child of childIds) reachable.add(child);
    if (!target || (target.route && studied.has(target.id))) satisfied.add(id);
  }
  function unstudied(target: PathTarget | undefined): target is PathTarget {
    return !!target?.route && !studied.has(target.id);
  }
  for (const id of pathOrder(path.nodes, path.rootIds, ready).keys()) {
    const target = path.nodes.get(id)!.target;
    if (unstudied(target)) return target;
  }
}

type DiscoveryManifest = Pick<
  PortfolioSnapshotV1,
  "curriculum" | "verifiedCurriculumIds"
>;

export function createPracticeDiscovery(manifest?: DiscoveryManifest) {
  if (!manifest) return { problems: [], paths: [] };
  const { curriculum, verifiedCurriculumIds } = manifest;
  const verified = new Set(verifiedCurriculumIds);
  const lessons = new Map(
    curriculum.lessons.map((lesson) => [lesson.problemId, lesson.route]),
  );
  const problems = curriculum.problems
    .flatMap((problem) => {
      const { id, number } = problem;
      const route = lessons.get(id);
      return verified.has(number) &&
        id === `leetcode:${number}` &&
        route === `/practice/leetcode/${number}/`
        ? [{ ...problem, route }]
        : [];
    })
    .sort((a, b) => a.number - b.number);
  const eligible = new Map(problems.map((problem) => [problem.id, problem]));
  const labels = new Map<string, Map<string, string>>();
  for (const { pathId, nodeId, title } of curriculum.pendingPathLabels) {
    const byNode = labels.get(pathId) ?? new Map<string, string>();
    byNode.set(nodeId, title);
    labels.set(pathId, byNode);
  }
  const paths = new Map<string, PracticeStudyPath>();
  for (const path of curriculum.paths) {
    if (paths.has(path.id)) throw new Error(`Duplicate path ${path.id}`);
    paths.set(path.id, createStudyPath(path, eligible, labels.get(path.id)));
  }
  return { problems, paths: [...paths.values()] };
}

let prepared: Promise<ReturnType<typeof createPracticeDiscovery>> | undefined;

export function readPreparedPracticeDiscovery() {
  return (prepared ??= readPreparedNotesManifest().then(
    createPracticeDiscovery,
  ));
}
