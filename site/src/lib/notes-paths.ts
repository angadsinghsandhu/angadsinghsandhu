import type { ContentEntry, Membership, Section } from "./notes-types.ts";

export const sectionLabels = {
  books: "Books",
  classes: "Classes",
  courses: "Courses",
  interview: "Interview",
  languages: "Languages",
  tutorials: "Tutorials",
} satisfies Record<Section, string>;

const naturalOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function compareSourcePaths(a: string, b: string): number {
  return naturalOrder.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The escape character is escaped too, so distinct source names retain distinct URLs. */
export function folderRoute(
  section: Section,
  segments: readonly string[],
): string {
  const path = segments
    .map((segment) =>
      encodeURIComponent(segment)
        .replace(
          /[!'()*~.]/gu,
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        )
        .replaceAll("%", "~"),
    )
    .join("/");
  return `/library/${section}/${path ? `folders/${path}/` : ""}`;
}

export function isReaderNote(entry: ContentEntry): boolean {
  return entry.kind === "markdown" || entry.kind === "notebook";
}

export function isLearningNote(entry: ContentEntry): boolean {
  return isReaderNote(entry) && entry.role !== "supplemental";
}

export function isLearningEntry(
  entry: ContentEntry,
  membership: Pick<Membership, "purpose" | "status">,
): boolean {
  return (
    entry.role !== "supplemental" &&
    membership.purpose !== "project-file" &&
    membership.status !== "outline"
  );
}

export function sourceLabel(entry: ContentEntry): string {
  if (
    entry.sourceUrl?.startsWith(
      "https://github.com/angadsinghsandhu/Notes/blob/",
    )
  ) {
    const path = new URL(entry.sourceUrl).pathname;
    const name = path.split("/").at(-1);
    if (name) {
      try {
        return decodeURIComponent(name);
      } catch {
        return entry.title;
      }
    }
  }
  return entry.title;
}
