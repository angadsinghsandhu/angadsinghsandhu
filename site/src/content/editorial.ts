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
  cover?: { src: string; alt: string };
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
  intro:
    "I’m a software engineer with a background in machine learning and natural language processing. I share projects and technical notes on what I’ve learned.",
  resume: {
    summary:
      "Software engineer with graduate training in computer science and research in natural language processing.",
    sections: [
      {
        heading: "Experience",
        items: ["Amazon · Software Development Engineer"],
      },
      {
        heading: "Education",
        items: [
          "Johns Hopkins University, Whiting School of Engineering · MSE in Computer Science, 2023–2025",
        ],
      },
      {
        heading: "Research and talks",
        items: [
          "Co-authored Temporal Analysis on Topics Using Word2Vec (arXiv:2209.11717).",
          "Co-presented the temporal topic analysis demo at PyData NYC 2024.",
        ],
      },
      {
        heading: "Selected projects",
        items: [
          "Dagnam.AI · Visual design and training tools for neural networks.",
          "Temporal Topic Analysis Demo · Word2Vec and clustering for tracking changes in topics over time.",
          "Tensortorch · A small neural network framework built with Python and NumPy.",
        ],
      },
    ],
  },
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

export const projects: readonly Project[] = [
  {
    slug: "dagnam-ai",
    title: "Dagnam.AI",
    summary: "A visual workspace for designing and training neural networks.",
    status: "approved",
    body: [
      "Dagnam.AI lets users assemble neural networks layer by layer and train the resulting models.",
      "The Python SDK lets users load datasets, follow training runs, retrieve checkpoints, and call deployed models from scripts or notebooks.",
    ],
    links: [
      { label: "Dagnam.AI", href: "https://dagnam.ai/" },
      { label: "Python SDK on PyPI", href: "https://pypi.org/project/dagnam/" },
    ],
  },
  {
    slug: "temporal-topic-analysis",
    title: "Temporal Topic Analysis Demo",
    summary:
      "A research demo for exploring how topics in a collection of texts change over time.",
    status: "approved",
    body: [
      "The demo uses Word2Vec embeddings and k-means clustering to group related terms, then compares those groups across time. It shows when topics move closer together or grow more distinct.",
      "We presented the demo at PyData NYC 2024 using examples from sports and COVID-19 news.",
    ],
    links: [
      {
        label: "Demo source code",
        href: "https://github.com/angadsinghsandhu/trends-demo",
      },
      {
        label: "PyData NYC 2024 talk",
        href: "https://pydata.org/nyc2024/schedule/talk/JLMSY9/",
      },
      { label: "Research preprint", href: "https://arxiv.org/abs/2209.11717" },
    ],
  },
  {
    slug: "tensortorch",
    title: "Tensortorch",
    summary: "A small neural network framework built with Python and NumPy.",
    status: "approved",
    body: [
      "I built Tensortorch from scratch to make the pieces of a neural network easier to study. The repository includes examples for classification and regression.",
    ],
    links: [
      {
        label: "Tensortorch source code",
        href: "https://github.com/angadsinghsandhu/tensortorch",
      },
    ],
  },
];
export const releases: readonly MusicRelease[] = [
  {
    slug: "never-gonna-give-you-up",
    title: "Never Gonna Give You Up",
    summary: "Rick Astley’s official music video.",
    status: "approved",
    embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    providers: [
      {
        label: "Watch on YouTube",
        href: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    ],
    tracks: ["Never Gonna Give You Up"],
    credits: [{ role: "Performer", name: "Rick Astley" }],
  },
];

export function approved<T extends Publication>(entries: readonly T[]) {
  return entries.filter((entry) => entry.status === "approved");
}
