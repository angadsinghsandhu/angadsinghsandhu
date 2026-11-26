import { compareSourcePaths, isLearningEntry } from "./notes-paths.ts";
import type {
  ContentEntry,
  Topic,
  Collection,
  Group,
  LearningPath,
  Membership,
  OrganizationSnapshot,
} from "./notes-types.ts";

type NodeBase = {
  id: string;
  title: string;
  summary: string;
  route: string;
  entryCount: number;
};
export type LibraryLink = Pick<NodeBase, "id" | "title" | "route">;
export type ResolvedPathStep = {
  id: string;
  title: string;
  summary: string;
  entries: LibraryLink[];
  topics: LibraryLink[];
};
export type LibraryNode = NodeBase &
  (
    | { type: "topic"; record: Topic }
    | { type: "collection"; record: Collection }
    | { type: "group"; record: Group }
    | { type: "path"; record: LearningPath; steps: ResolvedPathStep[] }
  );
export type OrganizationIndex = {
  routes(): string[];
  listNodes(type: LibraryNode["type"], parentKey?: string): LibraryNode[];
  getNode(type: LibraryNode["type"], key: string): LibraryNode | undefined;
  getMembership(entryId: string): Membership;
  listNodeEntries(
    type: "topic" | "collection" | "group",
    key: string,
    options?: { descendants?: boolean; scope?: "learning" | "files" },
  ): ContentEntry[];
};

type EntryNodeType = "topic" | "collection" | "group";
type Bucket = { direct: Set<string>; descendants: Set<string> };

export function buildOrganizationIndex(
  entries: readonly ContentEntry[],
  organization: OrganizationSnapshot,
): OrganizationIndex {
  const publicEntries = new Map(entries.map((entry) => [entry.id, entry]));
  const memberships = new Map(
    organization.memberships.map((m) => [m.entryId, m]),
  );
  const uids = new Map<string, ContentEntry>();
  const topics = ancestry(
    organization.topics,
    (topic) => topic.id,
    (topic) => topic.parentId,
  );
  const groups = ancestry(
    organization.groups,
    (group) => `${group.collectionId}/${group.id}`,
    (group) =>
      group.parentId ? `${group.collectionId}/${group.parentId}` : undefined,
  );
  const collections = new Set(
    organization.collections.map((collection) => collection.id),
  );
  if (
    collections.size !== organization.collections.length ||
    new Set(organization.paths.map((path) => path.id)).size !==
      organization.paths.length
  )
    throw new Error("Duplicate Notes collection or path ID");
  for (const group of organization.groups)
    if (!collections.has(group.collectionId))
      throw new Error(`Unknown Notes collection: ${group.collectionId}`);
  const buckets = new Map<string, Bucket>();
  const bucket = (type: EntryNodeType, key: string) => {
    const name = `${type}:${key}`;
    let value = buckets.get(name);
    if (!value) {
      value = { direct: new Set(), descendants: new Set() };
      buckets.set(name, value);
    }
    return value;
  };
  for (const entry of publicEntries.values()) {
    const m = memberships.get(entry.id)!;
    if (m.uid) uids.set(m.uid, entry);
    for (const assigned of m.topics) {
      bucket("topic", assigned).direct.add(entry.id);
      const lineage = topics.get(assigned);
      if (!lineage) throw new Error(`Unknown Notes topic: ${assigned}`);
      for (const id of lineage) bucket("topic", id).descendants.add(entry.id);
    }
    if (m.collectionId) {
      if (!collections.has(m.collectionId))
        throw new Error(`Unknown Notes collection: ${m.collectionId}`);
      const collection = bucket("collection", m.collectionId);
      collection.descendants.add(entry.id);
      if (!m.groupId) collection.direct.add(entry.id);
      else {
        const key = `${m.collectionId}/${m.groupId}`;
        bucket("group", key).direct.add(entry.id);
        const lineage = groups.get(key);
        if (!lineage) throw new Error(`Unknown Notes group: ${key}`);
        for (const id of lineage) bucket("group", id).descendants.add(entry.id);
      }
    }
  }
  const selectedIds = (
    type: EntryNodeType,
    key: string,
    descendants: boolean,
    scope: "learning" | "files",
  ) =>
    [
      ...(buckets.get(`${type}:${key}`)?.[
        descendants ? "descendants" : "direct"
      ] ?? []),
    ].filter(
      (id) =>
        scope === "files" ||
        isLearningEntry(publicEntries.get(id)!, memberships.get(id)!),
    );
  const nodes = new Map<string, LibraryNode>();
  const children = new Map<string, LibraryNode[]>();
  function add(node: LibraryNode, parent = ""): void {
    nodes.set(
      `${node.type}:${node.type === "group" ? `${node.record.collectionId}/${node.id}` : node.id}`,
      node,
    );
    const key = `${node.type}:${parent}`;
    const list = children.get(key) ?? [];
    list.push(node);
    children.set(key, list);
    if (node.type === "group" && !node.record.parentId) {
      const roots = children.get("group:") ?? [];
      roots.push(node);
      children.set("group:", roots);
    }
  }
  const base = (
    type: EntryNodeType,
    id: string,
    title: string,
    summary: string,
    key = id,
  ) => ({
    id,
    title,
    summary,
    route:
      type === "group"
        ? `/library/collections/${key.split("/")[0]}/groups/${id}/`
        : `/library/${type === "topic" ? "topics" : "collections"}/${id}/`,
    entryCount: selectedIds(type, key, true, "learning").length,
  });
  for (const t of organization.topics) {
    if (!selectedIds("topic", t.id, true, "files").length) continue;
    const { id, title, summary, parentId, order } = t;
    add(
      {
        ...base("topic", id, title, summary),
        type: "topic",
        record: {
          id,
          title,
          summary,
          ...(parentId ? { parentId } : {}),
          ...(order !== undefined ? { order } : {}),
        },
      },
      parentId,
    );
  }
  for (const c of organization.collections) {
    if (!selectedIds("collection", c.id, true, "files").length) continue;
    const {
      id,
      title,
      summary,
      type,
      provider,
      courseCode,
      edition,
      year,
      semester,
    } = c;
    add({
      ...base("collection", id, title, summary),
      type: "collection",
      record: {
        id,
        title,
        summary,
        type,
        ...(provider !== undefined ? { provider } : {}),
        ...(courseCode !== undefined ? { courseCode } : {}),
        ...(edition !== undefined ? { edition } : {}),
        ...(year !== undefined ? { year } : {}),
        ...(semester !== undefined ? { semester } : {}),
      },
    });
  }
  for (const g of organization.groups) {
    const key = `${g.collectionId}/${g.id}`;
    if (!selectedIds("group", key, true, "files").length) continue;
    const { id, title, summary, type, collectionId, parentId, order } = g;
    add(
      {
        ...base("group", id, title, summary, key),
        type: "group",
        record: {
          id,
          title,
          summary,
          type,
          collectionId,
          ...(parentId ? { parentId } : {}),
          ...(order !== undefined ? { order } : {}),
        },
      },
      parentId ? `${collectionId}/${parentId}` : collectionId,
    );
  }
  const link = ({ id, title, route }: LibraryLink): LibraryLink => ({
    id,
    title,
    route,
  });
  for (const p of organization.paths) {
    const entryIds = new Set<string>();
    const steps: ResolvedPathStep[] = [];
    for (const s of p.steps) {
      const stepEntries = s.entryUids
        .map((uid) => uids.get(uid))
        .filter(
          (e): e is ContentEntry =>
            !!e && isLearningEntry(e, memberships.get(e.id)!),
        );
      const stepTopics = s.topicIds
        .map((id) => nodes.get(`topic:${id}`))
        .filter((n): n is LibraryNode => !!n && n.entryCount > 0);
      if (!stepEntries.length && !stepTopics.length) continue;
      for (const e of stepEntries) entryIds.add(e.id);
      for (const t of stepTopics)
        for (const id of selectedIds("topic", t.id, true, "learning"))
          entryIds.add(id);
      steps.push({
        id: s.id,
        title: s.title,
        summary: s.summary,
        entries: stepEntries.map(link),
        topics: stepTopics.map(link),
      });
    }
    if (!steps.length) continue;
    add({
      id: p.id,
      title: p.title,
      summary: p.summary,
      type: "path",
      route: `/library/paths/${p.id}/`,
      entryCount: entryIds.size,
      record: {
        id: p.id,
        title: p.title,
        summary: p.summary,
        steps: p.steps.map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          entryUids: [...s.entryUids],
          topicIds: [...s.topicIds],
        })),
      },
      steps,
    });
  }
  for (const list of children.values())
    list.sort(
      (a, b) =>
        ("order" in a.record ? (a.record.order ?? Infinity) : Infinity) -
          ("order" in b.record ? (b.record.order ?? Infinity) : Infinity) ||
        compareSourcePaths(a.title, b.title) ||
        compareSourcePaths(a.id, b.id),
    );
  return {
    routes: () => Array.from(nodes.values(), ({ route }) => route),
    listNodes: (type, parentKey) =>
      structuredClone(children.get(`${type}:${parentKey ?? ""}`) ?? []),
    getNode: (type, key) => {
      const node = nodes.get(`${type}:${key}`);
      return node ? structuredClone(node) : undefined;
    },
    getMembership: (id) => {
      if (!publicEntries.has(id))
        throw new Error(`Unknown public entry: ${id}`);
      return structuredClone(memberships.get(id)!);
    },
    listNodeEntries: (type, key, options = {}) =>
      selectedIds(
        type,
        key,
        options.descendants ?? false,
        options.scope ?? "learning",
      ).map((id) => publicEntries.get(id)!),
  };
}

function ancestry<T>(
  items: T[],
  key: (item: T) => string,
  parent: (item: T) => string | undefined,
): Map<string, string[]> {
  const index = new Map(items.map((item) => [key(item), item]));
  if (index.size !== items.length)
    throw new Error("Duplicate Notes topic or group ID");
  const result = new Map<string, string[]>();
  for (const id of index.keys()) {
    const lineage = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      const item = index.get(current);
      if (item === undefined || lineage.has(current))
        throw new Error(`Invalid Notes organization ancestry: ${current}`);
      lineage.add(current);
      current = parent(item);
    }
    result.set(id, [...lineage]);
  }
  return result;
}
