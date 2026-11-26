export type EditorialLink = {
  label: string;
  href: string;
};

type Publication = {
  status: "draft" | "approved";
};

type Entry = Publication & {
  slug: string;
  title: string;
  summary: string;
};

export type Project = Entry & {
  body: readonly string[];
  links: readonly EditorialLink[];
};

export type MusicRelease = Entry & {
  cover: { src: string; alt: string };
  embedUrl: string;
  providers: readonly EditorialLink[];
  tracks: readonly string[];
  credits: readonly { role: string; name: string }[];
};

type Resume = {
  summary: string;
  sections: readonly { heading: string; items: readonly string[] }[];
};

export const resumePdfPath = "/resume.pdf";

export const profile: {
  name: string;
  intro?: string;
  resume?: Resume;
  links: readonly EditorialLink[];
} = {
  name: "Angad Sandhu",
  links: [
    { label: "LinkedIn", href: "https://linkedin.com/in/angad-sandhu" },
    { label: "Medium", href: "https://medium.com/@angadsandhu" },
    { label: "Twitter", href: "https://twitter.com/angadsandhuwork" },
    { label: "Buy Me a Coffee", href: "https://buymeacoffee.com/angadsandhu" },
  ],
};

export type EditorialIndex = {
  title: string;
  intro?: string;
  empty: string;
  links: readonly (EditorialLink & Publication)[];
};

export const indexes: Record<string, EditorialIndex> = {
  blog: { title: "Blog", empty: "No posts published yet.", links: [] },
  movies: {
    title: "Movies",
    empty: "No movie entries published yet.",
    links: [],
  },
  interesting: {
    title: "Interesting Stuff",
    empty: "No links collected here yet.",
    links: [],
  },
  interview: {
    title: "Interview",
    intro: "Interview topics and study paths are coming to the Notes library.",
    empty: "No interview paths published yet.",
    links: [{ label: "Browse Notes", href: "/library/", status: "approved" }],
  },
  library: {
    title: "Notes",
    empty: "The Notes library is being prepared for publication.",
    links: [],
  },
};

export const projects: readonly Project[] = [];
export const releases: readonly MusicRelease[] = [];

export function approved<T extends Publication>(entries: readonly T[]) {
  return entries.filter((entry) => entry.status === "approved");
}
